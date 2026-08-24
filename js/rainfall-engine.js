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

        // シート巡回と10分刻み時系列データの抽出
        const timeSeries = {};      // 'YYYYMMDD HH:MM' -> { [stationName]: 10minRain }
        const orderedTimestamps = [];

        fileList.forEach(fileItem => {
            const ab = fileItem.arrayBuffer;
            const fn = fileItem.filename || '';
            const wb = XLSX.read(ab, { type: 'array' });
            const sheetNames = wb.SheetNames;

            // 日付の推定 (ファイル名またはシート内のテキストから抽出)
            let baseDateStr = '';
            const fnMatch = fn.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
            if (fnMatch) {
                baseDateStr = `${fnMatch[1]}${fnMatch[2]}${fnMatch[3]}`;
            }

            sheetNames.forEach((sName, sheetIdx) => {
                const ws = wb.Sheets[sName];
                if (!ws) return;
                const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
                if (!data || data.length < 4) return;

                // 日付の抽出 (シート内文字列から)
                let sheetDateStr = baseDateStr;
                if (!sheetDateStr) {
                    for (let r = 0; r < Math.min(4, data.length); r++) {
                        const rowText = (data[r] || []).join(' ');
                        const m = rowText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/) || rowText.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
                        if (m) {
                            const y = m[1];
                            const mo = m[2].padStart(2, '0');
                            const d = m[3].padStart(2, '0');
                            sheetDateStr = `${y}${mo}${d}`;
                            break;
                        }
                    }
                }
                if (!sheetDateStr) {
                    const now = new Date();
                    sheetDateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
                }

                // 時間列の検出 (00:10 〜 24:00 等)
                let timeCols = []; // [{ colIdx, timeStr: 'HH:MM' }]

                for (let r = 0; r < Math.min(5, data.length); r++) {
                    const rowArr = data[r] || [];
                    const foundCols = [];
                    for (let c = 0; c < rowArr.length; c++) {
                        const val = String(rowArr[c] || '').trim();
                        const tm = val.match(/^(\d{1,2}):(\d{2})$/);
                        if (tm) {
                            const hh = tm[1].padStart(2, '0');
                            const mm = tm[2];
                            foundCols.push({ colIdx: c, timeStr: `${hh}:${mm}` });
                        }
                    }
                    if (foundCols.length >= 6) {
                        timeCols = foundCols;
                        break;
                    }
                }

                // 時間ヘッダーが見つからなかった場合のフォールバック（定時表1〜4の既定36列）
                if (timeCols.length === 0) {
                    const startHour = sheetIdx * 6;
                    const startCol = 3; // 通常4列目から雨量
                    for (let slot = 0; slot < 36; slot++) {
                        const totalMin = (slot + 1) * 10;
                        const h = Math.floor(totalMin / 60) + startHour;
                        const m = totalMin % 60;
                        const hh = String(h).padStart(2, '0');
                        const mm = String(m).padStart(2, '0');
                        timeCols.push({ colIdx: startCol + slot, timeStr: `${hh}:${mm}` });
                    }
                }

                // 各時間スロットを時系列に登録
                timeCols.forEach(tc => {
                    const tsKey = `${sheetDateStr} ${tc.timeStr}`;
                    if (!timeSeries[tsKey]) {
                        timeSeries[tsKey] = {};
                        orderedTimestamps.push(tsKey);
                    }

                    // 各観測局の雨量値抽出
                    stations.forEach(st => {
                        const rIdx = st.row - 1; // 0-indexed
                        let rainVal = 0;
                        if (data[rIdx] && data[rIdx][tc.colIdx] !== undefined && data[rIdx][tc.colIdx] !== null) {
                            const raw = data[rIdx][tc.colIdx];
                            const num = parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
                            if (!isNaN(num) && num >= 0) rainVal = num;
                        }
                        timeSeries[tsKey][st.name] = rainVal;
                    });
                });
            });
        });

        // タイムスタンプ順にソート（重複排除）
        const uniqueTimestamps = Array.from(new Set(orderedTimestamps)).sort();

        // 半減期パラメータ (短期: 1.5h = 90min, 長期: 72h = 4320min)
        const alpha = Math.pow(0.5, 10 / 90);      // 約 0.92587
        const beta = Math.pow(0.5, 10 / 4320);     // 約 0.998396

        // 局ごとの逐次実効雨量保持用
        const runningR = {};
        const timeSeriesRprime = {};
        const stationStats = {};

        stations.forEach(s => {
            runningR[s.name] = { r: 0, R: 0, history10m: [], cumulative: 0 };
            stationStats[s.row] = {
                row: s.row,
                name: s.name,
                city: s.city,
                cumulative: 0,
                cumulativeRaw: 0,
                max60: 0,
                max60Raw: 0,
                max60Time: '',
                max24: 0,
                max24Raw: 0,
                max24Time: '',
                maxRprime: 0,
                maxRprimeTime: '',
                maxRprimeLevel: 'normal'
            };
        });

        // 逐次 R'値、60分雨量、24時間雨量、累加雨量の計算
        uniqueTimestamps.forEach(tsKey => {
            timeSeriesRprime[tsKey] = {};
            stations.forEach(st => {
                const p = timeSeries[tsKey]?.[st.name] ?? 0;
                const state = runningR[st.name];

                // 累加雨量
                state.cumulative += p;

                // 実効雨量計算 (半減期 1.5h & 72h)
                state.r = (state.r * alpha) + p;
                state.R = (state.R * beta) + p;

                // R'土砂指標算定 (花崗岩・マサ土地域標準パラメータ R1=300, r1=60, 係数150)
                const rNorm = state.r / 60;
                const RNorm = state.R / 300;
                const rprimeVal = Math.round(Math.sqrt(rNorm * rNorm + RNorm * RNorm) * 150 * 10) / 10;
                timeSeriesRprime[tsKey][st.name] = rprimeVal;

                // 履歴管理 (直近144スロット = 24時間分)
                state.history10m.push(p);
                if (state.history10m.length > 144) state.history10m.shift();

                // 60分間雨量 (直近6スロットの合計)
                const last6 = state.history10m.slice(-6);
                const r60 = Math.round(last6.reduce((a, b) => a + b, 0) * 10) / 10;

                // 24時間雨量 (直近144スロットの合計)
                const r24 = Math.round(state.history10m.reduce((a, b) => a + b, 0) * 10) / 10;

                // 統計サマリーの更新
                const sum = stationStats[st.row];
                if (sum) {
                    sum.cumulative = Math.round(state.cumulative * 10) / 10;
                    sum.cumulativeRaw = sum.cumulative;

                    if (r60 >= sum.max60) {
                        sum.max60 = r60;
                        sum.max60Raw = r60;
                        sum.max60Time = tsKey;
                    }
                    if (r24 >= sum.max24) {
                        sum.max24 = r24;
                        sum.max24Raw = r24;
                        sum.max24Time = tsKey;
                    }
                    if (rprimeVal >= sum.maxRprime) {
                        sum.maxRprime = rprimeVal;
                        sum.maxRprimeTime = tsKey;
                        sum.maxRprimeLevel = evaluateMetricLevel('rprime', rprimeVal);
                    }
                }
            });
        });

        const startTs = uniqueTimestamps[0] || '';
        const endTs = uniqueTimestamps[uniqueTimestamps.length - 1] || '';

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
        const proxies = [
            (url) => `/api/proxy?url=${encodeURIComponent(url)}`,
            (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
            (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
            (url) => url // direct
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
                throw new Error(`${ymd} の定時表Excelの自動取得に失敗しました。広島県サイト（https://www.bousai.pref.hiroshima.lg.jp/data/observation/${y}/${m}/${ymd}-uryo.xlsx）にデータが公開されているかご確認ください。`);
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
                    </div>
                </div>
            `;
            marker.bindPopup(popupContent);
            stationsLayerGroup.addLayer(marker);
        });
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
