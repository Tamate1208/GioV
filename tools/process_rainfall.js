/**
 * GioVision Hiroshima - 雨量データ自動取得・解析スクリプト
 * 広島県防災情報ポータル（定時表Excel）から10分刻み実観測データを取得し、
 * 実効雨量 R'値・累加雨量・時間雨量を一括計算して静的JSONを生成します。
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');

// TCP/TLS接続プール（通信の安定化・高速化）
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 15000 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 15000 });
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.httpAgent = httpAgent;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATIONS_FILE = path.join(PROJECT_ROOT, 'data', 'rainfall_stations.json');
const OUTPUT_LATEST = path.join(PROJECT_ROOT, 'data', 'rainfall_latest.json');
const OUTPUT_DATA = path.join(PROJECT_ROOT, 'data', 'rainfall_data.json');
const DOWNLOAD_DIR = path.join(PROJECT_ROOT, 'temp_downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * 広島防災WEBから定時表Excelをダウンロード
 */
async function downloadRainfallXlsx(dateStr) {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const url = `https://www.bousai.pref.hiroshima.lg.jp/data/observation/${year}/${month}/${dateStr}-uryo.xlsx`;
    const dest = path.join(DOWNLOAD_DIR, `${dateStr}-uryo.xlsx`);

    // 既に本日終了後のファイルがあれば再利用
    if (fs.existsSync(dest)) {
        const day = parseInt(dateStr.substring(6, 8), 10);
        const dayCompleteUTC = new Date(Date.UTC(year, parseInt(month, 10) - 1, day + 1, 0, 0, 0) - 9 * 60 * 60 * 1000);
        const fileMtime = fs.statSync(dest).mtime;
        if (fileMtime > dayCompleteUTC) return dest;
    }

    console.log(`[ダウンロード中] ${url}`);
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*'
            }
        });
        try { fs.unlinkSync(dest); } catch (_) {}
        fs.writeFileSync(dest, response.data);
        return dest;
    } catch (e) {
        console.error(`[ダウンロード失敗] ${url}: ${e.message}`);
        return null;
    }
}

/**
 * 指定期間の雨量データを解析してJSONを生成
 */
async function processRainfallRange(startDateStr, endDateStr) {
    if (!fs.existsSync(STATIONS_FILE)) {
        throw new Error(`観測局マッピングファイルが見つかりません: ${STATIONS_FILE}`);
    }

    const mapping = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
    console.log(`[観測局読込完了] 全 ${mapping.length} 局`);

    const timeSeries = {};
    const timeSeriesRprime = {};
    const stationMaxes = {};
    const allValues = {};
    const allTimestamps = [];

    // --- 実効雨量 R' パラメータ (広島・花崗岩地帯) ---
    const RP_N = 72;     // Rw 半減期 (時間)
    const RP_M = 1.5;    // rw 半減期 (時間)
    const RP_R1 = 300;   // 楕円中心 Rw (mm)
    const RP_r1 = 60;    // 楕円中心 rw (mm)
    const RP_A = 3.0;    // 重み係数
    const ALPHA_RW = Math.pow(0.5, 1 / (6 * RP_N));
    const ALPHA_rw = Math.pow(0.5, 1 / (6 * RP_M));
    const RP_Rfw0 = Math.sqrt(RP_R1 ** 2 + RP_A ** 2 * RP_r1 ** 2);

    const start = new Date(startDateStr);
    const end = new Date(endDateStr);

    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(d.toISOString().split('T')[0].replace(/-/g, ''));
    }

    console.log(`[解析対象期間] ${startDateStr} 〜 ${endDateStr} (${dates.length} 日間)`);

    const downloaded = await Promise.all(dates.map(dStr => downloadRainfallXlsx(dStr)));
    const filePaths = downloaded.filter(Boolean);

    if (filePaths.length === 0) {
        throw new Error('指定期間の有効な雨量データ（Excel）が1件も取得できませんでした。');
    }

    // 日付順にソートして処理
    filePaths.sort().forEach(filePath => {
        const fileName = path.basename(filePath);
        const dateStr = fileName.split('-')[0];
        console.log(`[Excel解析中] ${fileName}`);

        const workbook = XLSX.readFile(filePath, { cellStyles: false, cellHTML: false, cellFormula: false });
        const sheetNames = ['雨量定時表1', '雨量定時表2', '雨量定時表3', '雨量定時表4'];

        // 1日を 144 個の null スロット（10分刻み）で初期化
        const dayData = {};
        mapping.forEach(s => dayData[s.row] = new Array(144).fill(null));

        sheetNames.forEach((sheetName, sidx) => {
            const sheet = workbook.Sheets[sheetName];
            if (!sheet) return;

            for (let r = 4; r <= 450; r++) {
                if (dayData[r] === undefined) continue;
                for (let c = 2; c <= 37; c++) {
                    const cellAddress = XLSX.utils.encode_cell({ r: r - 1, c: c });
                    const cell = sheet[cellAddress];
                    const val = cell && !isNaN(parseFloat(cell.v)) ? parseFloat(cell.v) : null;

                    const slotIndex = (sidx * 36) + (c - 2);
                    if (slotIndex < 144) dayData[r][slotIndex] = val;
                }
            }
        });

        const dayTimestamps = [];
        for (let i = 0; i < 144; i++) {
            const h = Math.floor((i + 1) * 10 / 60);
            const m = ((i + 1) * 10) % 60;
            const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            const ts = (timeStr === '24:00') ? `${dateStr} 23:59` : `${dateStr} ${timeStr}`;
            dayTimestamps.push(ts);
        }
        allTimestamps.push(...dayTimestamps);

        mapping.forEach(station => {
            const row = station.row;
            if (!allValues[row]) allValues[row] = [];
            allValues[row].push(...(dayData[row]));
        });
    });

    console.log(`[指標計算開始] 全 ${allTimestamps.length} スロットの指標算出中...`);

    mapping.forEach(station => {
        const row = station.row;
        const values = allValues[row] || [];
        stationMaxes[row] = {
            max60: null, max60Raw: null, max24: null, max24Raw: null,
            max60Time: '', max60RawTime: '', max24Time: '', max24RawTime: '',
            cumulative: null, cumulativeRaw: null,
            maxRprime: null, maxRprimeTime: '', maxRprimeLevel: 'normal'
        };

        let Rw_state = 0;
        let rw_state = 0;

        for (let i = 0; i < values.length; i++) {
            const ts = allTimestamps[i] || '';
            const p10 = values[i] ?? 0; // 欠測は0mmとして減衰のみ計算

            // 実効雨量 Rw・rw の更新
            Rw_state = ALPHA_RW * Rw_state + p10;
            rw_state = ALPHA_rw * rw_state + p10;

            // R' 値の算出
            const Rfw = Math.sqrt(Math.pow(RP_R1 - Rw_state, 2) + Math.pow(RP_A * (RP_r1 - rw_state), 2));
            const rprime = Math.max(0, Math.round((RP_Rfw0 - Rfw) * 10) / 10);

            if (!timeSeriesRprime[ts]) timeSeriesRprime[ts] = {};
            timeSeriesRprime[ts][station.name] = rprime;

            if (stationMaxes[row].maxRprime === null || rprime > stationMaxes[row].maxRprime) {
                stationMaxes[row].maxRprime = rprime;
                stationMaxes[row].maxRprimeTime = ts;
                if      (rprime >= 250) stationMaxes[row].maxRprimeLevel = 'danger';
                else if (rprime >= 175) stationMaxes[row].maxRprimeLevel = 'caution';
                else if (rprime >= 125) stationMaxes[row].maxRprimeLevel = 'watch';
                else                   stationMaxes[row].maxRprimeLevel = 'normal';
            }

            // 60分間雨量ローリング
            const win60Full = values.slice(Math.max(0, i - 5), i + 1);
            const win60Valid = win60Full.filter(v => v !== null);

            if (win60Valid.length > 0) {
                const sum60Raw = win60Valid.reduce((a, b) => a + b, 0);
                if (stationMaxes[row].max60Raw === null || sum60Raw > stationMaxes[row].max60Raw) {
                    stationMaxes[row].max60Raw = sum60Raw;
                    stationMaxes[row].max60RawTime = ts;
                }
            }

            if (win60Full.length === 6 && win60Valid.length === 6) {
                const sum60 = win60Valid.reduce((a, b) => a + b, 0);
                if (!timeSeries[ts]) timeSeries[ts] = {};
                timeSeries[ts][station.name] = sum60;

                if (stationMaxes[row].max60 === null || sum60 > stationMaxes[row].max60) {
                    stationMaxes[row].max60 = sum60;
                    stationMaxes[row].max60Time = ts;
                }
            } else {
                if (!timeSeries[ts]) timeSeries[ts] = {};
                timeSeries[ts][station.name] = null;
            }

            // 24時間雨量ローリング
            const win24Full = values.slice(Math.max(0, i - 143), i + 1);
            const win24Valid = win24Full.filter(v => v !== null);

            if (win24Valid.length > 0) {
                const rawSum = win24Valid.reduce((a, b) => a + b, 0);
                if (stationMaxes[row].max24Raw === null || rawSum > stationMaxes[row].max24Raw) {
                    stationMaxes[row].max24Raw = rawSum;
                    stationMaxes[row].max24RawTime = ts;
                }

                const estimatedSum = (win24Valid.length >= Math.ceil(144 * 0.8))
                    ? Math.round((rawSum * (144 / win24Valid.length)) * 10) / 10
                    : rawSum;

                if (stationMaxes[row].max24 === null || estimatedSum > stationMaxes[row].max24) {
                    stationMaxes[row].max24 = estimatedSum;
                    stationMaxes[row].max24Time = ts;
                }
            }
        }

        // 全期間累加雨量
        const allValid = values.filter(v => v !== null);
        if (allValid.length > 0) {
            const rawSum = allValid.reduce((a, b) => a + b, 0);
            stationMaxes[row].cumulativeRaw = rawSum;
            const validRatio = allValid.length / values.length;
            stationMaxes[row].cumulative = (validRatio >= 0.8)
                ? Math.round((rawSum * (values.length / allValid.length)) * 10) / 10
                : rawSum;
        }
    });

    // 未来時刻の余剰スロットを削除
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const nowDateStr = nowJST.toISOString().replace('T', ' ').substring(0, 16).replace(/-/g, '');
    Object.keys(timeSeries).forEach(ts => {
        if (ts > nowDateStr) delete timeSeries[ts];
    });
    Object.keys(timeSeriesRprime).forEach(ts => {
        if (ts > nowDateStr) delete timeSeriesRprime[ts];
    });

    // --- 故障局検出（周囲3局以上が雨なのに自身が0mm） ---
    console.log('[品質検査] 故障・異常値観測局の自動検証中...');
    const distKm = (lat1, lon1, lat2, lon2) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    mapping.forEach(target => {
        const row = target.row;
        const targetSummary = stationMaxes[row];
        if (targetSummary.max24Raw === 0) {
            let wetNeighborCount = 0;
            mapping.forEach(other => {
                if (target.row === other.row) return;
                const d = distKm(target.lat, target.lon, other.lat, other.lon);
                if (d < 15) {
                    const otherMax = stationMaxes[other.row].max24 || 0;
                    if (otherMax >= 5) wetNeighborCount++;
                }
            });

            if (wetNeighborCount >= 3) {
                console.log(`[故障検知・除外] ${target.city} ${target.name} (周囲3局以上降雨中に全期間0mm)`);
                stationMaxes[row].max60 = null;
                stationMaxes[row].max60Raw = null;
                stationMaxes[row].max24 = null;
                stationMaxes[row].max24Raw = null;
                stationMaxes[row].cumulative = null;
                stationMaxes[row].cumulativeRaw = null;

                Object.keys(timeSeries).forEach(ts => {
                    if (timeSeries[ts][target.name] !== undefined) timeSeries[ts][target.name] = null;
                });
            }
        }
    });

    const outputData = {
        mapping: mapping,
        timeSeries: timeSeries,
        timeSeriesRprime: timeSeriesRprime,
        summary: stationMaxes,
        range: { start: startDateStr, end: endDateStr }
    };

    const jsonStr = JSON.stringify(outputData);
    fs.writeFileSync(OUTPUT_LATEST, jsonStr, 'utf8');
    fs.writeFileSync(OUTPUT_DATA, jsonStr, 'utf8');

    console.log(`[出力完了] ${OUTPUT_LATEST} (${(jsonStr.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[出力完了] ${OUTPUT_DATA} (${(jsonStr.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`✓ 正常終了: 対象期間 ${startDateStr} 〜 ${endDateStr} の雨量・R'データを生成しました。`);
}

// コマンドライン引数の処理
const args = process.argv.slice(2);
let startArg = args[0];
let endArg = args[1];

if (!startArg || !endArg) {
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const yesterdayJST = new Date(nowJST.getTime() - 24 * 60 * 60 * 1000);
    const formatDate = (d) => d.toISOString().split('T')[0];

    startArg = formatDate(yesterdayJST);
    endArg = formatDate(nowJST);
    console.log(`[自動算出期間] ${startArg} 〜 ${endArg}`);
}

processRainfallRange(startArg, endArg)
    .then(() => process.exit(0))
    .catch(err => {
        console.error(`[致命的エラー] ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    });
