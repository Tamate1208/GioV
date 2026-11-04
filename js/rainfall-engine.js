/**
 * GioVision Hiroshima - Rainfall & R' Sediment Disaster Risk Engine
 * (広島県防災情報ポータル 実観測データ・hiroshima-rainfall 連携モジュール)
 */

window.RainfallEngine = (function () {
    let currentMode = 'latest';         // 'latest' (最新/アクセス時評価) | 'heisei30' (平成30年災実測データ)
    let datasets = {
        heisei30: null,
        latest: null
    };

    let activeData = null;              // 現在選択中のデータセット (rainfall_data.json形式)
    let stations = [];                  // 観測局マスタ (mapping: 408局)
    let timestamps = [];                // 10分毎の実測タイムスタンプ一覧
    let currentTimestampIndex = -1;     // -1: 期間内最大値 (サマリー), 0以上: 指定タイムスタンプ
    let activeStationData = {};         // station.name -> 統合実測値オブジェクト
    let stationsLayerGroup = null;
    let currentMetric = 'cumulative';    // 'cumulative' | 'rprime' | 'max60' | 'max24'

    // 各指標の警戒閾値・カラー定義
    const RISK_LEVELS = {
        danger:  { label: '極めて危険（避難指示相当）', short: '危険', color: '#dc2626', bg: 'bg-red-600', text: 'text-red-600', lightBg: 'bg-red-50', border: 'border-red-500' },
        caution: { label: '警戒（高齢者等避難相当）', short: '警戒', color: '#ea580c', bg: 'bg-orange-500', text: 'text-orange-600', lightBg: 'bg-orange-50', border: 'border-orange-500' },
        watch:   { label: '注意（大雨注意報相当）', short: '注意', color: '#eab308', bg: 'bg-yellow-500', text: 'text-yellow-600', lightBg: 'bg-yellow-50', border: 'border-yellow-500' },
        normal:  { label: '平常（基準未満）', short: '平常', color: '#3b82f6', bg: 'bg-blue-500', text: 'text-blue-600', lightBg: 'bg-blue-50', border: 'border-blue-500' }
    };

    // 指標別の閾値判定関数
    function evaluateMetricLevel(metric, val) {
        if (metric === 'cumulative') {
            // 降り始めからの累加雨量 (mm)
            if (val >= 200) return 'danger';    // 200mm以上: 飽和土砂崩壊危険
            if (val >= 150) return 'caution';   // 150mm以上: 土砂災害警戒情報基準
            if (val >= 100) return 'watch';     // 100mm以上: 大雨警報基準
            return 'normal';
        } else if (metric === 'rprime') {
            // 実効雨量土砂指標 R'
            if (val >= 250) return 'danger';
            if (val >= 175) return 'caution';
            if (val >= 125) return 'watch';
            return 'normal';
        } else if (metric === 'max60') {
            // 60分雨量 (mm/h)
            if (val >= 50) return 'danger';     // 非常に激しい雨
            if (val >= 30) return 'caution';    // 激しい雨
            if (val >= 20) return 'watch';      // やや強い雨 (災害採択基準)
            return 'normal';
        } else if (metric === 'max24') {
            // 24時間雨量 (mm/24h)
            if (val >= 200) return 'danger';
            if (val >= 150) return 'caution';
            if (val >= 80)  return 'watch';     // 80mm以上: 国の災害復旧事業採択基準
            return 'normal';
        }
        return 'normal';
    }

    /**
     * 初期化: 平成30年災データおよび最新データの事前読み込み
     */
    async function init(mapInstance) {
        stationsLayerGroup = L.layerGroup();

        try {
            // 1. 平成30年7月豪雨実測データ読み込み
            const resH30 = await fetch('data/rainfall_heisei30.json');
            if (resH30.ok) {
                datasets.heisei30 = await resH30.json();
            }

            // 2. 最新観測データ読み込み
            const resLatest = await fetch('data/rainfall_latest.json');
            if (resLatest.ok) {
                datasets.latest = await resLatest.json();
            } else {
                // フォールバック
                const resDefault = await fetch('data/rainfall_data.json');
                if (resDefault.ok) datasets.latest = await resDefault.json();
            }

            // 初期モード: 最新/アクセス時評価
            switchDataset('latest');

        } catch (e) {
            console.error('RainfallEngine init error:', e);
        }
    }

    /**
     * データセットの切替 ('heisei30' | 'latest')
     */
    function switchDataset(mode) {
        currentMode = mode;
        activeData = datasets[mode] || datasets.heisei30 || datasets.latest;
        if (!activeData) return;

        stations = activeData.mapping || [];
        timestamps = Object.keys(activeData.timeSeries || {});

        // 最新モード時は最新アクセス時刻（末尾スロット）をデフォルト表示
        // 平成30年災モード時は期間最大サマリー（-1）をデフォルト表示
        if (mode === 'latest' && timestamps.length > 0) {
            setTimelineStep(timestamps.length - 1);
        } else {
            setTimelineStep(-1);
        }
    }

    /**
     * 表示指標の切替 ('cumulative' | 'rprime' | 'max60' | 'max24')
     */
    function setMetric(metricName) {
        currentMetric = metricName;
        updateStationMarkers();
    }

    /**
     * タイムライン指定ステップの実測値反映 (-1: 期間内最大値, 0以上: 10分刻みタイムスタンプ)
     */
    function setTimelineStep(index) {
        currentTimestampIndex = index;
        if (!activeData) return;

        const summary = activeData.summary || {};
        const timeSeries = activeData.timeSeries || {};
        const timeSeriesRprime = activeData.timeSeriesRprime || {};

        activeStationData = {};

        if (index === -1 || !timestamps[index]) {
            // --- 期間内最大・累加サマリーモード ---
            stations.forEach(s => {
                const sum = summary[s.row] || {};
                const rprime = sum.maxRprime ?? 0;
                const cum = sum.cumulativeRaw ?? sum.cumulative ?? 0;
                const max60 = sum.max60Raw ?? sum.max60 ?? 0;
                const max24 = sum.max24Raw ?? sum.max24 ?? 0;

                activeStationData[s.name] = {
                    row: s.row,
                    name: s.name,
                    city: s.city,
                    lat: s.lat,
                    lon: s.lon,
                    cumulative: cum,
                    rprime: rprime,
                    max60: max60,
                    max24: max24,
                    cumulativeLevel: evaluateMetricLevel('cumulative', cum),
                    rprimeLevel: evaluateMetricLevel('rprime', rprime),
                    max60Level: evaluateMetricLevel('max60', max60),
                    max24Level: evaluateMetricLevel('max24', max24),
                    maxRprimeTime: sum.maxRprimeTime || '',
                    max60Time: sum.max60Time || '',
                    max24Time: sum.max24Time || ''
                };
            });
        } else {
            // --- 特定タイムスタンプの実測値モード ---
            const ts = timestamps[index];
            const rainAtTs = timeSeries[ts] || {};
            const rprimeAtTs = timeSeriesRprime[ts] || {};

            stations.forEach(s => {
                const sum = summary[s.row] || {};
                const rprime = rprimeAtTs[s.name] ?? 0;
                const r60 = rainAtTs[s.name] ?? 0;
                const cum = sum.cumulativeRaw ?? sum.cumulative ?? 0;
                const max24 = sum.max24Raw ?? sum.max24 ?? 0;

                activeStationData[s.name] = {
                    row: s.row,
                    name: s.name,
                    city: s.city,
                    lat: s.lat,
                    lon: s.lon,
                    cumulative: cum,
                    rprime: rprime,
                    max60: r60,
                    max24: max24,
                    cumulativeLevel: evaluateMetricLevel('cumulative', cum),
                    rprimeLevel: evaluateMetricLevel('rprime', rprime),
                    max60Level: evaluateMetricLevel('max60', r60),
                    max24Level: evaluateMetricLevel('max24', max24),
                    timestamp: ts
                };
            });
        }

        updateStationMarkers();
    }

    /**
     * 広島県防災WEB 定時表 Excel (.xlsx) のブラウザ内直接解析 & R'実効雨量エンジン
     * (server.js不要・SheetJSを利用してブラウザ単体で完全計算・複数日ファイル一括取込対応)
     */
    async function loadCustomXlsx(input, defaultFilename = '') {
        if (typeof XLSX === 'undefined') {
            throw new Error('SheetJS (xlsx.full.min.js) が読み込まれていません。');
        }

        // 観測局マスタの確認・読み込み
        if (!stations || stations.length === 0) {
            try {
                const resSt = await fetch('data/rainfall_stations.json');
                if (resSt.ok) stations = await resSt.json();
            } catch (e) {
                console.warn('Stations master fetch failed:', e);
            }
        }

        // 入力を配列形式に統一 [{ arrayBuffer, filename }]
        const fileList = Array.isArray(input)
            ? input
            : [{ arrayBuffer: input, filename: defaultFilename }];

        // 各局・全期間の10分生データ集約用の構造
        const allValues = {};     // stationRow -> Array of 10min values (or null)
        const allTimestamps = []; // YYYYMMDD HH:MM の全タイムスタンプ

        // パラメータ定数 (hiroshima-rainfall 共通)
        const RP_N    = 72;    // Rw 半減期 (時間)
        const RP_M    = 1.5;   // rw 半減期 (時間)
        const RP_R1   = 300;   // 楕円中心 Rw (mm)
        const RP_r1   = 60;    // 楕円中心 rw (mm)
        const RP_A    = 3.0;   // 重み係数
        const ALPHA_RW  = Math.pow(0.5, 1 / (6 * RP_N));
        const ALPHA_rw  = Math.pow(0.5, 1 / (6 * RP_M));
        const RP_Rfw0 = Math.sqrt(RP_R1 ** 2 + (RP_A * RP_r1) ** 2);

        stations.forEach(s => {
            allValues[s.row] = [];
        });

        fileList.forEach(fileItem => {
            const ab = fileItem.arrayBuffer;
            const fn = fileItem.filename || '';
            const wb = XLSX.read(ab, { type: 'array' });

            let dateStr = '';
            const fnMatch = fn.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
            if (fnMatch) {
                dateStr = `${fnMatch[1]}${fnMatch[2]}${fnMatch[3]}`;
            } else {
                const now = new Date();
                dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
            }

            const sheetNames = ['雨量定時表1', '雨量定時表2', '雨量定時表3', '雨量定時表4'];
            const dayData = {};
            stations.forEach(s => dayData[s.row] = new Array(144).fill(null));

            sheetNames.forEach((sheetName, sidx) => {
                const sheet = wb.Sheets[sheetName];
                if (!sheet) return;

                stations.forEach(st => {
                    const r = st.row;
                    for (let c = 2; c <= 37; c++) {
                        const cellAddress = XLSX.utils.encode_cell({ r: r - 1, c: c });
                        const cell = sheet[cellAddress];
                        const val = (cell && cell.v !== undefined && cell.v !== null && !isNaN(parseFloat(cell.v)))
                            ? parseFloat(cell.v)
                            : null;
                        const slotIndex = (sidx * 36) + (c - 2);
                        if (slotIndex < 144) dayData[r][slotIndex] = val;
                    }
                });
            });

            // 1日 144 スロットのタイムスタンプ生成
            for (let i = 0; i < 144; i++) {
                const totalMin = (i + 1) * 10;
                const h = Math.floor(totalMin / 60);
                const m = totalMin % 60;
                let ts = '';
                if (h === 24 && m === 0) {
                    ts = `${dateStr} 23:59`;
                } else {
                    const hh = String(h).padStart(2, '0');
                    const mm = String(m).padStart(2, '0');
                    ts = `${dateStr} ${hh}:${mm}`;
                }
                allTimestamps.push(ts);
            }

            stations.forEach(st => {
                const row = st.row;
                if (dayData[row]) {
                    allValues[row].push(...dayData[row]);
                }
            });
        });

        // 60分雨量 (timeSeries) および R'指標 (timeSeriesRprime) の計算
        const timeSeries = {};
        const timeSeriesRprime = {};
        const stationMaxes = {};

        stations.forEach(st => {
            const row = st.row;
            const values = allValues[row] || [];

            stationMaxes[row] = {
                row: row,
                name: st.name,
                city: st.city,
                max60: null, max60Raw: null, max24: null, max24Raw: null,
                max60Time: '', max60RawTime: '', max24Time: '', max24RawTime: '',
                cumulative: null, cumulativeRaw: null,
                maxRprime: null, maxRprimeTime: '', maxRprimeLevel: 'normal'
            };

            let Rw_state = 0;
            let rw_state = 0;

            for (let i = 0; i < values.length; i++) {
                const ts = allTimestamps[i] || '';
                const p10 = values[i] ?? 0; // 欠測は減衰のみ継続

                // --- 実効雨量 Rw・rw を更新 ---
                Rw_state = ALPHA_RW * Rw_state + p10;
                rw_state = ALPHA_rw * rw_state + p10;

                // --- R' を計算 ---
                const Rfw = Math.sqrt(Math.pow(RP_R1 - Rw_state, 2) + Math.pow(RP_A * (RP_r1 - rw_state), 2));
                const rprime = Math.max(0, Math.round((RP_Rfw0 - Rfw) * 10) / 10);

                if (!timeSeriesRprime[ts]) timeSeriesRprime[ts] = {};
                timeSeriesRprime[ts][st.name] = rprime;

                if (stationMaxes[row].maxRprime === null || rprime > stationMaxes[row].maxRprime) {
                    stationMaxes[row].maxRprime = rprime;
                    stationMaxes[row].maxRprimeTime = ts;
                    if      (rprime >= 250) stationMaxes[row].maxRprimeLevel = 'danger';
                    else if (rprime >= 175) stationMaxes[row].maxRprimeLevel = 'caution';
                    else if (rprime >= 125) stationMaxes[row].maxRprimeLevel = 'watch';
                    else                    stationMaxes[row].maxRprimeLevel = 'normal';
                }

                // --- 60分ローリング (JMA基準: 60分間/6スロット揃っている場合は合計) ---
                const win60Full = values.slice(Math.max(0, i - 5), i + 1);
                const win60Valid = win60Full.filter(v => v !== null);

                if (win60Full.length === 6 && win60Valid.length === 6) {
                    const sum60 = Math.round(win60Valid.reduce((a, b) => a + b, 0) * 10) / 10;
                    if (!timeSeries[ts]) timeSeries[ts] = {};
                    timeSeries[ts][st.name] = sum60;

                    if (stationMaxes[row].max60 === null || sum60 > stationMaxes[row].max60) {
                        stationMaxes[row].max60 = sum60;
                        stationMaxes[row].max60Time = ts;
                    }
                } else {
                    if (!timeSeries[ts]) timeSeries[ts] = {};
                    timeSeries[ts][st.name] = null;
                }

                // --- 24時間ローリング ---
                const win24Full = values.slice(Math.max(0, i - 143), i + 1);
                const win24Valid = win24Full.filter(v => v !== null);
                if (win24Valid.length > 0) {
                    const rawSum = win24Valid.reduce((a, b) => a + b, 0);
                    const estimatedSum = Math.round((rawSum * (144 / win24Valid.length)) * 10) / 10;
                    if (stationMaxes[row].max24 === null || estimatedSum > stationMaxes[row].max24) {
                        stationMaxes[row].max24 = estimatedSum;
                        stationMaxes[row].max24Time = ts;
                    }
                }
            }

            const allValid = values.filter(v => v !== null);
            if (allValid.length > 0) {
                const rawSum = allValid.reduce((a, b) => a + b, 0);
                stationMaxes[row].cumulativeRaw = Math.round(rawSum * 10) / 10;
                stationMaxes[row].cumulative = Math.round((rawSum * (values.length / allValid.length)) * 10) / 10;
            }
        });

        const startTs = allTimestamps[0] || '';
        const endTs = allTimestamps[allTimestamps.length - 1] || '';

        const datasetResult = {
            mapping: stations,
            range: { start: startTs, end: endTs },
            timeSeries: timeSeries,
            timeSeriesRprime: timeSeriesRprime,
            summary: stationStats
        };

        datasets.latest = datasetResult;
        switchDataset('latest');

        return {
            success: true,
            count: stations.length,
            range: datasetResult.range,
            slots: orderedTimestamps.length
        };
    }

    /**
     * 外部で生成した rainfall_data.json の直接取り込み
     */
    function loadCustomJson(json) {
        if (!json || !json.timeSeries) {
            throw new Error('不正な rainfall_data.json 形式です。');
        }
        datasets.latest = json;
        switchDataset('latest');
        return {
            success: true,
            count: (json.mapping || stations).length,
            range: json.range || { start: '', end: '' }
        };
    }

    /**
     * 指定された日付範囲 (startDate 〜 endDate) の定時表Excelを自動ダウンロードして解析
     * (CORSプロキシ / ローカルAPI / ダイレクトフェッチの自動フォールバック対応)
     */
    async function fetchAndProcessDateRange(startDateStr, endDateStr, onProgress = null) {
        if (!startDateStr || !endDateStr) {
            throw new Error('開始日と終了日を指定してください。');
        }

        const start = new Date(startDateStr);
        const end = new Date(endDateStr);
        if (start > end) {
            throw new Error('開始日は終了日以前の日付を指定してください。');
        }

        const dateList = [];
        const cur = new Date(start);
        while (cur <= end) {
            const y = cur.getFullYear();
            const m = String(cur.getMonth() + 1).padStart(2, '0');
            const d = String(cur.getDate()).padStart(2, '0');
            dateList.push({ y, m, d, ymd: `${y}${m}${d}` });
            cur.setDate(cur.getDate() + 1);
        }

        const fileList = [];
        // 最優先: 自前サーバー/APIプロキシ (/api/proxy)
        // フォールバック: パブリックCORSプロキシ / ダイレクト
        const proxies = [
            (url) => `/api/proxy?url=${encodeURIComponent(url)}`,
            (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
            (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
            (url) => url // direct (CORS制限がない環境用)
        ];

        for (let i = 0; i < dateList.length; i++) {
            const { y, m, ymd } = dateList[i];
            const candidateUrls = [
                `https://www.bousai.pref.hiroshima.lg.jp/data/observation/${y}/${m}/${ymd}-uryo.xlsx`,
                `http://www.bousai.pref.hiroshima.jp/contents/regular/table/${ymd}-uryo.xlsx`
            ];

            if (onProgress) onProgress(ymd, i + 1, dateList.length);

            let arrayBuffer = null;
            let lastError = null;

            for (const targetUrl of candidateUrls) {
                if (arrayBuffer) break;
                for (const proxyFn of proxies) {
                    try {
                        const reqUrl = proxyFn(targetUrl);
                        const res = await fetch(reqUrl, { cache: 'no-cache' });
                        if (res.ok) {
                            const buf = await res.arrayBuffer();
                            if (buf && buf.byteLength > 1000) { // 有効なExcelバイナリ (エラーHTMLでない)
                                arrayBuffer = buf;
                                break;
                            }
                        }
                    } catch (e) {
                        lastError = e;
                    }
                }
            }

            if (!arrayBuffer) {
                throw new Error(`${ymd} の定時表Excelの自動取得に失敗しました。サーバープロキシ（server.js）が稼働しているか、または手動でExcelファイルをドラッグ＆ドロップしてください。`);
            }

            fileList.push({
                arrayBuffer: arrayBuffer,
                filename: `${ymd}-uryo.xlsx`
            });
        }

        // ダウンロードした全ファイルをブラウザ内エンジンで解析・R'計算
        return await loadCustomXlsx(fileList);
    }

    /**
     * 広島県防災WEBから最新データを取得・解析（自動実行インターフェース）
     */
    async function updateFromHiroshimaBousaiWeb(startDate, endDate, onProgress = null) {
        return await fetchAndProcessDateRange(startDate, endDate, onProgress);
    }

    /**
     * 2地点間の距離計算 (Haversine km)
     */
    function distanceKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * 任意座標 (lat, lng) における雨量データの空間抽出 (最寄り局およびIDW補間)
     */
    function evaluateLocationRainfall(lat, lng) {
        if (!stations || stations.length === 0 || Object.keys(activeStationData).length === 0) {
            return null;
        }

        const nearby = stations.map(s => {
            const dist = distanceKm(lat, lng, s.lat, s.lon);
            const data = activeStationData[s.name] || {
                cumulative: 0, rprime: 0, max60: 0, max24: 0,
                cumulativeLevel: 'normal', rprimeLevel: 'normal'
            };
            return {
                ...s,
                dist: dist,
                data: data
            };
        }).sort((a, b) => a.dist - b.dist);

        const nearest = nearby[0];

        // 上位3局によるIDW補間
        const k = Math.min(3, nearby.length);
        let weightSum = 0;
        let weightedCum = 0;
        let weightedRprime = 0;
        let weightedMax60 = 0;
        let weightedMax24 = 0;

        for (let i = 0; i < k; i++) {
            const item = nearby[i];
            const w = 1 / Math.max(0.2, Math.pow(item.dist, 2));
            weightSum += w;
            weightedCum += (item.data.cumulative || 0) * w;
            weightedRprime += (item.data.rprime || 0) * w;
            weightedMax60 += (item.data.max60 || 0) * w;
            weightedMax24 += (item.data.max24 || 0) * w;
        }

        const estCum = Math.round((weightedCum / weightSum) * 10) / 10;
        const estRprime = Math.round((weightedRprime / weightSum) * 10) / 10;
        const estMax60 = Math.round((weightedMax60 / weightSum) * 10) / 10;
        const estMax24 = Math.round((weightedMax24 / weightSum) * 10) / 10;

        const dataRange = activeData?.range || { start: '', end: '' };
        const modeLabel = currentMode === 'heisei30' ? '平成30年7月豪雨（西日本豪雨実測）' : '最新 広島防災WEB実測データ';

        const currentLabel = currentTimestampIndex === -1
            ? `${modeLabel} 期間最大 (${dataRange.start} 〜 ${dataRange.end})`
            : `${modeLabel} [${timestamps[currentTimestampIndex] || ''}]`;

        return {
            mode: currentMode,
            modeLabel: modeLabel,
            nearestStation: {
                row: nearest.row,
                name: nearest.name,
                city: nearest.city,
                distKm: Math.round(nearest.dist * 10) / 10,
                cumulative: nearest.data.cumulative,
                rprime: nearest.data.rprime,
                max60: nearest.data.max60,
                max24: nearest.data.max24,
                cumulativeLevel: nearest.data.cumulativeLevel,
                rprimeLevel: nearest.data.rprimeLevel,
                maxRprimeTime: nearest.data.maxRprimeTime || ''
            },
            interpolated: {
                cumulative: estCum,
                rprime: estRprime,
                max60: estMax60,
                max24: estMax24,
                cumulativeLevel: evaluateMetricLevel('cumulative', estCum),
                rprimeLevel: evaluateMetricLevel('rprime', estRprime)
            },
            dataRange: dataRange,
            currentTimestamp: currentTimestampIndex === -1 ? 'PEAK' : timestamps[currentTimestampIndex],
            timelineLabel: currentLabel
        };
    }

    /**
     * 雨量観測局マーカーの更新描画 (選択中の metric に応じた表示)
     */
    function updateStationMarkers() {
        if (!stationsLayerGroup) return;
        stationsLayerGroup.clearLayers();

        stations.forEach(s => {
            const data = activeStationData[s.name];
            if (!data) return;

            let val = 0;
            let valUnit = '';
            let valLabel = '';
            let lvlKey = 'normal';

            if (currentMetric === 'cumulative') {
                val = data.cumulative;
                valUnit = 'mm';
                valLabel = '降り始め累加雨量';
                lvlKey = data.cumulativeLevel;
            } else if (currentMetric === 'rprime') {
                val = data.rprime;
                valUnit = '';
                valLabel = '実効雨量土砂指標 R\'';
                lvlKey = data.rprimeLevel;
            } else if (currentMetric === 'max60') {
                val = data.max60;
                valUnit = 'mm/h';
                valLabel = '60分間雨量';
                lvlKey = data.max60Level;
            } else if (currentMetric === 'max24') {
                val = data.max24;
                valUnit = 'mm/24h';
                valLabel = '24時間雨量';
                lvlKey = data.max24Level;
            }

            const lvl = RISK_LEVELS[lvlKey] || RISK_LEVELS.normal;

            const markerHtml = `
                <div class="relative flex items-center justify-center cursor-pointer group" title="${s.city} ${s.name}: ${valLabel} ${val}${valUnit}">
                    ${lvlKey === 'danger' ? '<div class="absolute w-8 h-8 rounded-full bg-red-500 animate-ping opacity-60 pointer-events-none"></div>' : ''}
                    <div class="transition-transform transform group-hover:scale-125 group-hover:-translate-y-0.5" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.5)) drop-shadow(0 0 1.5px #ffffff);">
                        <svg class="w-5 h-6" viewBox="0 0 24 26" fill="none">
                            <path d="M12 2C12 2 4.5 12 4.5 17.5C4.5 21.64 7.86 25 12 25C16.14 25 19.5 21.64 19.5 17.5C19.5 12 12 2 12 2Z"
                                  fill="${lvl.color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
                            <path d="M8.5 15C8 16.8 9 19.2 10.8 20.2" stroke="rgba(255,255,255,0.75)" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                    </div>
                </div>
            `;

            const icon = L.divIcon({
                className: 'bg-transparent',
                html: markerHtml,
                iconSize: [22, 26],
                iconAnchor: [11, 13]
            });

            const marker = L.marker([s.lat, s.lon], { icon: icon });
            const dataRange = activeData?.range || { start: '', end: '' };

            const timeInfo = currentTimestampIndex === -1
                ? (data.maxRprimeTime ? `最大時: ${data.maxRprimeTime}` : `対象期間: ${dataRange.start}〜${dataRange.end}`)
                : `観測時刻: ${timestamps[currentTimestampIndex]}`;

            const popupContent = `
                <div class="p-1 min-w-[250px] font-sans text-xs">
                    <div class="flex items-center justify-between border-b pb-1 mb-2">
                        <div>
                            <div class="font-bold text-gray-900 text-sm">${s.city} / ${s.name}</div>
                            <div class="text-[9px] text-gray-500">広島防災WEB 定時表 第${s.row}行</div>
                        </div>
                        <span class="text-[10px] px-2 py-0.5 rounded text-white font-bold" style="background-color: ${lvl.color};">${lvl.short}</span>
                    </div>

                    <div class="space-y-1.5">
                        <!-- 降り始めからの累加雨量 (実測) -->
                        <div class="bg-blue-50 border border-blue-200 p-2 rounded-lg">
                            <div class="flex justify-between items-center text-blue-900">
                                <span class="font-bold text-[11px]">🌧 降り始めからの累加雨量:</span>
                                <span class="font-black text-sm text-blue-700">${data.cumulative} <span class="text-[10px] font-normal">mm</span></span>
                            </div>
                        </div>

                        <!-- 実効雨量 R' -->
                        <div class="flex justify-between items-center bg-gray-50 p-1.5 rounded">
                            <span class="text-gray-700 font-medium">実効雨量土砂指標 R'</span>
                            <span class="font-bold text-sm" style="color: ${RISK_LEVELS[data.rprimeLevel]?.color || '#3b82f6'};">${data.rprime} <span class="text-[10px] font-normal text-gray-500">(/250)</span></span>
                        </div>

                        <!-- 60分雨量 & 24時間雨量 -->
                        <div class="grid grid-cols-2 gap-1.5 text-[11px]">
                            <div class="p-1 bg-slate-50 rounded border border-slate-100">
                                <span class="text-gray-500 text-[10px] block">60分雨量:</span>
                                <span class="font-bold text-gray-800">${data.max60} mm/h</span>
                            </div>
                            <div class="p-1 bg-slate-50 rounded border border-slate-100">
                                <span class="text-gray-500 text-[10px] block">24時間雨量:</span>
                                <span class="font-bold text-gray-800">${data.max24} mm/24h</span>
                            </div>
                        </div>

                        <div class="mt-1 text-[10px] text-gray-400 border-t pt-1 flex justify-between">
                            <span>${currentMode === 'heisei30' ? '平成30年7月豪雨' : '最新観測'}</span>
                            <span>${timeInfo}</span>
                        </div>

                        <!-- 一般ユーザー向け 時系列グラフモーダル起動ボタン -->
                        <div class="pt-1">
                            <button onclick="openRainfallChartModal('${s.name}')"
                                    class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-1.5 px-2 rounded-lg text-xs shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
                                <span>📊 雨量＆地中水分グラフを見る</span>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            marker.bindPopup(popupContent);
            stationsLayerGroup.addLayer(marker);
        });
    }

    /**
     * 観測局の時系列雨量・R'実効雨量および一般ユーザー向け防災アドバイスの生成
     */
    function getStationTimeSeries(stationName) {
        if (!activeData || !stations) return null;
        const targetStation = stations.find(s => s.name === stationName);
        if (!targetStation) return null;

        const timeSeries = activeData.timeSeries || {};
        const timeSeriesRprime = activeData.timeSeriesRprime || {};
        const summary = activeData.summary?.[targetStation.row] || {};
        const currentData = activeStationData[stationName] || {};

        const labels = [];
        const rainSeries = [];
        const rprimeSeries = [];

        // グラフ描画用タイムスタンプ（間引き処理: 100件超は3スロット毎、200件超は6スロット=1時間毎）
        const stepInterval = timestamps.length > 200 ? 6 : (timestamps.length > 100 ? 3 : 1);

        for (let i = 0; i < timestamps.length; i++) {
            const ts = timestamps[i];
            if (i % stepInterval !== 0 && i !== timestamps.length - 1) continue;

            const parts = ts.split(' ');
            let shortTs = ts;
            if (parts.length === 2) {
                const datePart = parts[0];
                const timePart = parts[1];
                const m = parseInt(datePart.substring(4, 6), 10);
                const d = parseInt(datePart.substring(6, 8), 10);
                shortTs = `${m}/${d} ${timePart}`;
            }
            labels.push(shortTs);

            const r60 = timeSeries[ts]?.[stationName] ?? 0;
            const rp = timeSeriesRprime[ts]?.[stationName] ?? 0;
            rainSeries.push(r60);
            rprimeSeries.push(rp);
        }

        const curRprime = currentData.rprime ?? 0;
        const curRain60 = currentData.max60 ?? 0;
        const maxRprime = summary.maxRprime ?? curRprime;

        let riskAdvice = {
            level: 'normal',
            badgeText: '平常（警戒解除）',
            badgeBg: 'bg-blue-600',
            bgClass: 'bg-blue-50/70',
            borderClass: 'border-blue-200',
            headline: '現在の土砂災害危険度は平常レベルです',
            detail: '現時点では山や斜面の保水力に十分な余裕があります。今後の降雨情報や土砂ハザードマップをご確認ください。',
            isGroundWaterAlert: false,
            groundWaterMsg: '',
            marginMsg: '通常（危険基準値まで十分な余裕があります）'
        };

        if (curRprime >= 250) {
            riskAdvice = {
                level: 'danger',
                badgeText: '極めて危険（避難指示相当）',
                badgeBg: 'bg-red-600',
                bgClass: 'bg-red-50',
                borderClass: 'border-red-300',
                headline: '山が耐えられる水分限界を超えています！直ちに避難してください',
                detail: '地中の水分量が飽和状態に達し、土石流やがけ崩れがいつ起きてもおかしくありません。周囲の安全な避難所、または建物の2階以上（山と反対側の部屋）へ緊急避難してください。',
                isGroundWaterAlert: curRain60 < 10,
                groundWaterMsg: '雨が小降りになったり止んでいても、地盤内部の水分（R\'）は依然として危険域にあります。絶対に斜面や渓流に近づかないでください。',
                marginMsg: '限界超過中（直ちに身を守る行動をとってください）'
            };
        } else if (curRprime >= 175) {
            riskAdvice = {
                level: 'caution',
                badgeText: '警戒（高齢者等避難相当）',
                badgeBg: 'bg-orange-600',
                bgClass: 'bg-orange-50',
                borderClass: 'border-orange-300',
                headline: '土砂崩れのリスクが非常に高まっています。高齢者等は避難を開始してください',
                detail: '過去の土砂災害が多発し始める危険水準です。夜間になって周囲が見えなくなる前、雨足がさらに強まる前に、安全な場所への移動を開始してください。',
                isGroundWaterAlert: curRain60 < 5,
                groundWaterMsg: '降雨の峠を越えても、地中の水分が抜けるまで数時間は危険な状態が続きます。引き続き警戒を緩めないでください。',
                marginMsg: 'あと強い雨（約25mm/h）が30〜60分継続すると、避難指示レベル（R\'=250）に達します'
            };
        } else if (curRprime >= 125) {
            riskAdvice = {
                level: 'watch',
                badgeText: '注意（大雨注意報レベル）',
                badgeBg: 'bg-yellow-500',
                bgClass: 'bg-yellow-50',
                borderClass: 'border-yellow-300',
                headline: '地盤に雨水が浸透しています。今後の雨の強まりに注意してください',
                detail: '斜面の小石の転がり、湧き水の濁り、地鳴りなど、土砂災害の前兆現象に注意してください。ハザードマップで避難経路を再確認しておきましょう。',
                isGroundWaterAlert: false,
                groundWaterMsg: '',
                marginMsg: 'あと激しい雨（30mm/h）が約1〜2時間続くと、高齢者等避難レベル（R\'=175）に達します'
            };
        } else {
            if (maxRprime >= 175 && currentTimestampIndex === -1) {
                riskAdvice.headline = `期間中に警戒域（最大 R'=${maxRprime}）を記録しました`;
                riskAdvice.detail = `対象期間内で土砂災害の危険が大きく高まった時間帯がありました。画面下のタイムラインバーを動かすと、当時の推移を振り返ることができます。`;
            }
        }

        return {
            station: targetStation,
            summary: summary,
            current: currentData,
            labels: labels,
            rainSeries: rainSeries,
            rprimeSeries: rprimeSeries,
            riskAdvice: riskAdvice
        };
    }

    return {
        init,
        switchDataset,
        setMetric,
        setTimelineStep,
        updateFromHiroshimaBousaiWeb,
        fetchAndProcessDateRange,
        loadCustomJson,
        loadCustomXlsx,
        evaluateLocationRainfall,
        evaluateMetricLevel,
        getStationTimeSeries,
        getStationsLayer: () => stationsLayerGroup,
        getStations: () => stations,
        getTimestamps: () => timestamps,
        getDataRange: () => activeData?.range || { start: '', end: '' },
        getActiveStationData: () => activeStationData,
        getCurrentTimestampIndex: () => currentTimestampIndex,
        getCurrentMode: () => currentMode,
        getCurrentMetric: () => currentMetric,
        RISK_LEVELS
    };
})();
