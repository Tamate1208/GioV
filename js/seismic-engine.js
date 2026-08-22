/**
 * GioVision Hiroshima - Geotechnical & Seismic Hazard Engine
 * (ボーリング柱状図N値・土質・水位解析 & 地震増幅率・液状化評価モジュール)
 */

window.SeismicEngine = (function () {

    /**
     * 土質とN値からせん断波速度 Vs (m/s) を推定
     * (日本道路協会「道路橋示方書」および国土交通省・建築基準法算定式準拠)
     */
    function estimateVs(layer) {
        const type = layer.type || 'Other';
        const n = Math.max(1, layer.nValue || (layer.nIsRefusal ? 50 : 1));
        const rawName = (layer.rawName || '').toLowerCase();

        if (type === 'Rock' || rawName.includes('岩') || rawName.includes('基盤')) {
            if (layer.nIsRefusal || n >= 50) return 600;
            return 400 + n * 4;
        }
        if (type === 'Sand' || rawName.includes('砂') || rawName.includes('マサ') || rawName.includes('まさ')) {
            return Math.round(80 * Math.pow(n, 0.33));
        }
        if (type === 'Clay' || type === 'Organic' || rawName.includes('粘') || rawName.includes('シルト') || rawName.includes('泥')) {
            return Math.round(100 * Math.pow(n, 0.33));
        }
        if (type === 'Gravel' || rawName.includes('礫')) {
            return Math.round(100 * Math.pow(n, 0.33));
        }
        return Math.round(80 * Math.pow(n, 0.33));
    }

    /**
     * ボーリング孔データから AVS30 (表層30m平均S波速度) および増幅率 (ARV) を算出
     * @param {Object} point - ボーリングデータ項目 (depth, layers, groundwater)
     */
    function evaluateBoreholeSeismic(point) {
        if (!point || !point.layers || point.layers.length === 0) {
            return {
                avs30: 300,
                arv: 1.5,
                shakingLevel: 'moderate',
                shakingCategory: '普通 (第2種地盤相当)',
                liquefactionRisk: 'unknown',
                liquefactionScore: 0,
                liquefactionText: 'データ不足'
            };
        }

        const layers = point.layers;
        let cumulativeDepth = 0;
        let sumHdivVs = 0;
        let lastVs = 200;

        // 30mまでの層厚と速度の累積
        layers.forEach(layer => {
            const thick = layer.thickness ?? (layer.endDepth - layer.startDepth);
            if (cumulativeDepth >= 30 || thick <= 0) return;

            const effectiveThick = Math.min(thick, 30 - cumulativeDepth);
            const vs = estimateVs(layer);
            lastVs = vs;

            sumHdivVs += effectiveThick / vs;
            cumulativeDepth += effectiveThick;
        });

        // 30mに満たない場合は、最下層の地盤が30mまで続くと仮定（最下層が岩盤なら岩盤速度）
        if (cumulativeDepth < 30) {
            const remaining = 30 - cumulativeDepth;
            const extendedVs = layers[layers.length - 1]?.type === 'Rock' ? Math.max(500, lastVs) : lastVs;
            sumHdivVs += remaining / extendedVs;
        }

        const avs30 = Math.round(30 / sumHdivVs);

        // J-SHIS / 翠川らの表層地盤増幅率推定式: ARV = 10^(1.83 - 0.66 * log10(AVS30))
        const logAvs = Math.log10(Math.max(50, avs30));
        const arv = Math.round(Math.pow(10, 1.83 - 0.66 * logAvs) * 100) / 100;

        // 揺れやすさカテゴリ判定
        let shakingLevel = 'moderate';
        let shakingCategory = '普通';
        let shakingColor = '#3b82f6';
        let groundType = '第2種地盤（砂礫・洪積層）';

        if (arv >= 2.1 || avs30 < 160) {
            shakingLevel = 'very_high';
            shakingCategory = '極めて揺れやすい';
            shakingColor = '#dc2626';
            groundType = '第4種地盤（超軟弱層・臨海埋立地・泥炭地）';
        } else if (arv >= 1.7 || avs30 < 250) {
            shakingLevel = 'high';
            shakingCategory = '揺れやすい';
            shakingColor = '#ea580c';
            groundType = '第3種地盤（沖積低地・軟弱粘性土層）';
        } else if (arv >= 1.3 || avs30 < 400) {
            shakingLevel = 'moderate';
            shakingCategory = '普通';
            shakingColor = '#eab308';
            groundType = '第2種地盤（砂礫・硬質洪積層・段丘）';
        } else {
            shakingLevel = 'low';
            shakingCategory = '揺れにくい';
            shakingColor = '#10b981';
            groundType = '第1種地盤（硬質岩盤・山地・洪積高台）';
        }

        // --- 液状化リスク判定 (簡易判定) ---
        // 条件: 深度 <= 15m, 地下水位以深, 砂質土, N値 < 20
        const gwDepth = point.groundwater?.representative ?? 2.0; // 水位不明時は2m仮定
        let susceptibleThickness = 0;
        let severeThickness = 0;

        layers.forEach(layer => {
            if (layer.startDepth >= 15) return; // 深度15m以深は影響小
            const isSand = layer.type === 'Sand' || (layer.rawName && (layer.rawName.includes('砂') || layer.rawName.includes('マサ')));
            if (!isSand) return;

            // 地下水位以深の層厚を計算
            const layerTop = layer.startDepth;
            const layerBottom = Math.min(15, layer.endDepth);
            if (layerBottom <= gwDepth) return; // 地下水位より上は液状化しにくい

            const wetTop = Math.max(layerTop, gwDepth);
            const wetThick = Math.max(0, layerBottom - wetTop);

            const n = layer.nValue ?? (layer.nIsRefusal ? 50 : 15);
            if (n < 10) {
                severeThickness += wetThick;
                susceptibleThickness += wetThick;
            } else if (n < 20) {
                susceptibleThickness += wetThick;
            }
        });

        let liquefactionRisk = 'low';
        let liquefactionScore = 20; // 0-100
        let liquefactionText = '極めて低い（岩盤・粘土または高N値）';
        let liqColor = '#10b981';

        if (severeThickness >= 3.0 || (susceptibleThickness >= 5.0 && gwDepth <= 2.5)) {
            liquefactionRisk = 'high';
            liquefactionScore = 85;
            liquefactionText = '極めて高い（浅い地下水位＋軟弱砂層）';
            liqColor = '#dc2626';
        } else if (severeThickness >= 1.0 || susceptibleThickness >= 2.5) {
            liquefactionRisk = 'moderate';
            liquefactionScore = 55;
            liquefactionText = '注意（砂質土層あり・揺れにより発生の恐れ）';
            liqColor = '#ea580c';
        } else if (susceptibleThickness > 0) {
            liquefactionRisk = 'low';
            liquefactionScore = 35;
            liquefactionText = '低い（砂層が薄いかN値が比較的高い）';
            liqColor = '#eab308';
        }

        return {
            avs30,
            arv,
            shakingLevel,
            shakingCategory,
            shakingColor,
            groundType,
            groundwaterDepth: gwDepth,
            liquefactionRisk,
            liquefactionScore,
            liquefactionText,
            liqColor,
            details: {
                susceptibleThickness: Math.round(susceptibleThickness * 10) / 10,
                severeThickness: Math.round(severeThickness * 10) / 10
            }
        };
    }

    /**
     * J-SHIS および 国土地理院 地震・地盤オープンデータ WMS/WMTS レイヤー定義
     */
    function getTileLayers() {
        return {
            // 国土地理院 土地条件図タイル
            landCondition: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/lcm256_2019/{z}/{x}/{y}.png', {
                attribution: '国土地理院 土地条件図',
                maxZoom: 17,
                opacity: 0.65
            }),
            // 国土地理院 治水地形分類図タイル
            floodTerrain: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/lcmfc2/{z}/{x}/{y}.png', {
                attribution: '国土地理院 治水地形分類図',
                maxZoom: 17,
                opacity: 0.65
            }),
            // 国土地理院 色別標高図
            relief: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png', {
                attribution: '国土地理院 色別標高図',
                maxZoom: 15,
                opacity: 0.55
            }),
            // 国土地理院 陰影起伏図
            hillshade: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png', {
                attribution: '国土地理院 陰影起伏図',
                maxZoom: 16,
                opacity: 0.5
            }),
            // 国土交通省 重ねるハザードマップ（洪水浸水想定区域）
            floodHazard: L.tileLayer('https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png', {
                attribution: '国交省 洪水浸水想定区域（想定最大）',
                maxZoom: 17,
                opacity: 0.65
            }),
            // 国土交通省 高潮浸水想定区域
            stormSurgeHazard: L.tileLayer('https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png', {
                attribution: '国交省 高潮浸水想定区域',
                maxZoom: 17,
                opacity: 0.65
            }),
            // 国土交通省 津波浸水想定
            tsunamiHazard: L.tileLayer('https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png', {
                attribution: '国交省 津波浸水想定',
                maxZoom: 17,
                opacity: 0.65
            })
        };
    }

    return {
        evaluateBoreholeSeismic,
        getTileLayers,
        estimateVs
    };
})();
