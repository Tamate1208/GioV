/**
 * GioVision Hiroshima - Disaster Risk Carte (地点防災カルテ)
 * (地震・土砂・水害の複合リスク総合診断 & 広島防災WEB実観測データ連携モジュール)
 */

window.DisasterCarte = (function () {

    /**
     * 地点における総合防災診断を実行
     * @param {Object} boreholeData - ボーリングデータ（存在する場合）
     * @param {number} lat - 緯度
     * @param {number} lng - 経度
     */
    function diagnoseLocation(boreholeData, lat, lng) {
        // 1. 地震・地盤評価
        const seismic = window.SeismicEngine.evaluateBoreholeSeismic(boreholeData);

        // 2. 降雨・R'土砂リスク評価 (広島防災WEBの実観測データ)
        const rainfall = window.RainfallEngine.evaluateLocationRainfall(lat, lng);

        // 3. 地質・表層まさ土・斜面リスクの判定
        let isGraniteOrMasa = false;
        let surfaceSoil = '一般土質';

        if (boreholeData && boreholeData.layers) {
            const topLayer = boreholeData.layers[0];
            const topName = (topLayer?.rawName || '').toLowerCase();
            if (topName.includes('マサ') || topName.includes('まさ') || topName.includes('花崗岩') || topLayer?.type === 'Sand') {
                isGraniteOrMasa = true;
                surfaceSoil = 'マサ土（風化花崗岩・崩壊要注意）';
            } else if (topLayer?.type === 'Rock') {
                surfaceSoil = '岩盤（強固）';
            } else {
                surfaceSoil = topLayer?.rawName || topLayer?.type || '砂礫・粘性土';
            }
        }

        // 4. レーダーチャート用 5軸スコアの算出 (0〜100: 高いほど安全)
        // 軸1: 地盤耐震性 (AVS30が高いほど安全)
        const seismicScore = Math.min(100, Math.max(15, Math.round((seismic.avs30 / 500) * 100)));

        // 軸2: 液状化耐性 (リスクが低いほど安全)
        const liqScore = Math.max(10, 100 - seismic.liquefactionScore);

        // 軸3: 降雨土砂耐性 (実測R'値および降り始め累加雨量による総合評価)
        const curRprime = rainfall?.nearestStation?.rprime ?? rainfall?.interpolated?.rprime ?? 0;
        const curCumulative = rainfall?.nearestStation?.cumulative ?? rainfall?.interpolated?.cumulative ?? 0;
        
        let sedimentScore = Math.max(10, Math.min(100, Math.round(100 - (curRprime / 2.5))));
        if (curCumulative >= 200) {
            sedimentScore = Math.max(10, sedimentScore - 20);
        } else if (curCumulative >= 150) {
            sedimentScore = Math.max(10, sedimentScore - 10);
        }

        if (isGraniteOrMasa && (curRprime >= 125 || curCumulative >= 100)) {
            sedimentScore = Math.max(10, sedimentScore - 15);
        }

        // 軸4: 水害耐性 (孔内地下水位が深いほど安全)
        const gwDepth = boreholeData?.groundwater?.representative ?? 2.0;
        const waterScore = Math.min(100, Math.max(20, Math.round((gwDepth / 6.0) * 80 + 20)));

        // 軸5: 地層安定性 (岩盤深度が浅く硬質地盤であるほど安全)
        const hasRock = boreholeData?.layers?.some(l => l.type === 'Rock');
        const stabilityScore = hasRock ? 90 : (seismic.avs30 >= 300 ? 75 : 45);

        // 総合安全度スコア (加重平均)
        const overallScore = Math.round(
            seismicScore * 0.25 +
            liqScore * 0.20 +
            sedimentScore * 0.30 +
            waterScore * 0.15 +
            stabilityScore * 0.10
        );

        // 総合防災ランク判定 (S:極めて安全 〜 D:複合危険)
        let overallRank = 'B';
        let rankColor = '#3b82f6';
        let rankBadge = 'bg-blue-600 text-white';
        let rankSummary = '標準的な安全水準です。';

        if (overallScore >= 80) {
            overallRank = 'S';
            rankColor = '#10b981';
            rankBadge = 'bg-emerald-600 text-white';
            rankSummary = '多重ハザードに対して極めて高い耐性を持つ堅固な地点です。';
        } else if (overallScore >= 65) {
            overallRank = 'A';
            rankColor = '#059669';
            rankBadge = 'bg-green-600 text-white';
            rankSummary = '概ね良好な地盤・防災環境です。';
        } else if (overallScore >= 50) {
            overallRank = 'B';
            rankColor = '#eab308';
            rankBadge = 'bg-yellow-500 text-white';
            rankSummary = '豪雨時または大地震時に特定のリスクが生じる可能性があります。';
        } else if (overallScore >= 35) {
            overallRank = 'C';
            rankColor = '#ea580c';
            rankBadge = 'bg-orange-600 text-white';
            rankSummary = '土砂災害・液状化・強い揺れのいずれかで警戒が必要な地点です。';
        } else {
            overallRank = 'D';
            rankColor = '#dc2626';
            rankBadge = 'bg-red-600 text-white';
            rankSummary = '複合的な災害リスク（土砂崩落・液状化・浸水）が高く、早期避難が必要な地点です。';
        }

        // 防災提言リスト
        const recommendations = [];
        if (curRprime >= 250 || curCumulative >= 200) {
            recommendations.push({
                type: 'urgent',
                title: '土砂災害への厳重警戒（避難指示相当）',
                desc: `降り始めからの累加雨量が【${curCumulative}mm】(R'=${curRprime})に達し、土壌が完全飽和状態です。斜面近傍から直ちに離れ、指定避難所または建物の2階以上山側反対側へ退避してください。`
            });
        } else if (curRprime >= 175 || curCumulative >= 150) {
            recommendations.push({
                type: 'warning',
                title: '土砂災害警戒（高齢者等避難相当）',
                desc: `降り始めからの累加雨量が【${curCumulative}mm】(R'=${curRprime})に達しています。土砂災害警戒情報基準に達しているため、斜面付近にお住まいの方は避難準備を整えてください。`
            });
        }

        if (seismic.liquefactionRisk === 'high' || seismic.liquefactionRisk === 'moderate') {
            recommendations.push({
                type: 'warning',
                title: '地震時の液状化対策',
                desc: `浅層に低N値の砂質層が存在し、地下水位が浅いため液状化が懸念されます。給排水管の耐震化や基礎構造の確認を推奨します。`
            });
        }
        if (seismic.arv >= 1.7) {
            recommendations.push({
                type: 'info',
                title: '地震動の増幅（強い揺れへの備え）',
                desc: `表層地盤増幅率が ${seismic.arv} と高めです。家具の転倒防止具設置や非常持出袋の備蓄を徹底してください。`
            });
        }
        if (recommendations.length === 0) {
            recommendations.push({
                type: 'good',
                title: '日常の防災意識の維持',
                desc: '現在目立ったハザード突出は見られませんが、日頃から最寄りの指定緊急避難場所と避難経路を確認しておきましょう。'
            });
        }

        return {
            lat,
            lng,
            boreholeId: boreholeData?.id || '任意指定地点',
            boreholeDescription: boreholeData?.description || 'ボーリングデータ近傍',
            surfaceSoil,
            seismic,
            rainfall,
            scores: {
                seismic: seismicScore,
                liquefaction: liqScore,
                sediment: sedimentScore,
                water: waterScore,
                stability: stabilityScore,
                overall: overallScore
            },
            overallRank,
            rankColor,
            rankBadge,
            rankSummary,
            recommendations
        };
    }

    /**
     * 5角形レーダーチャートのSVG文字列を生成
     */
    function renderRadarChartSvg(scores, size = 200) {
        const center = size / 2;
        const radius = size * 0.38;
        const labels = ['耐震性', '液状化耐性', '土砂耐性(R\')', '水害耐性', '地層安定性'];
        const values = [
            scores.seismic,
            scores.liquefaction,
            scores.sediment,
            scores.water,
            scores.stability
        ];
        const numAxes = 5;
        const angleStep = (Math.PI * 2) / numAxes;

        // 背景の同心多角形
        let gridLines = '';
        [0.2, 0.4, 0.6, 0.8, 1.0].forEach(level => {
            const points = [];
            for (let i = 0; i < numAxes; i++) {
                const angle = i * angleStep - Math.PI / 2;
                const r = radius * level;
                const x = center + r * Math.cos(angle);
                const y = center + r * Math.sin(angle);
                points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
            }
            gridLines += `<polygon points="${points.join(' ')}" fill="none" stroke="#e5e7eb" stroke-width="1" />`;
        });

        // 軸線とラベル
        let axisLines = '';
        let labelElements = '';
        for (let i = 0; i < numAxes; i++) {
            const angle = i * angleStep - Math.PI / 2;
            const x = center + radius * Math.cos(angle);
            const y = center + radius * Math.sin(angle);
            axisLines += `<line x1="${center}" y1="${center}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="2,2"/>`;

            const lx = center + (radius + 18) * Math.cos(angle);
            const ly = center + (radius + 14) * Math.sin(angle) + 4;
            labelElements += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="#4b5563">${labels[i]}</text>`;
        }

        // データ多角形
        const dataPoints = [];
        for (let i = 0; i < numAxes; i++) {
            const angle = i * angleStep - Math.PI / 2;
            const r = radius * (values[i] / 100);
            const x = center + r * Math.cos(angle);
            const y = center + r * Math.sin(angle);
            dataPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }

        const polygon = `<polygon points="${dataPoints.join(' ')}" fill="rgba(59, 130, 246, 0.35)" stroke="#2563eb" stroke-width="2" />`;

        return `
            <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="mx-auto overflow-visible">
                ${gridLines}
                ${axisLines}
                ${polygon}
                ${labelElements}
            </svg>
        `;
    }

    /**
     * カルテモーダル/パネルのHTML生成
     */
    function buildCarteHtml(diagnosis) {
        const { scores, seismic, rainfall, recommendations } = diagnosis;
        const rf = rainfall?.interpolated || {};
        const near = rainfall?.nearestStation || {};

        const cum = near.cumulative ?? rf.cumulative ?? 0;
        const rprime = near.rprime ?? rf.rprime ?? 0;
        const max60 = near.max60 ?? rf.max60 ?? 0;
        const max24 = near.max24 ?? rf.max24 ?? 0;

        const cumLevel = window.RainfallEngine.evaluateMetricLevel('cumulative', cum);
        const cumLvlObj = window.RainfallEngine.RISK_LEVELS[cumLevel] || window.RainfallEngine.RISK_LEVELS.normal;

        const rLvlObj = window.RainfallEngine.RISK_LEVELS[near.rprimeLevel || rf.rprimeLevel] || window.RainfallEngine.RISK_LEVELS.normal;

        return `
            <div class="space-y-4 text-gray-800 font-sans">
                <!-- ヘッダーサマリー -->
                <div class="flex items-center justify-between bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 text-white p-4 rounded-xl shadow-md">
                    <div>
                        <div class="text-[10px] uppercase tracking-wider text-indigo-300 font-bold">防災地盤カルテ</div>
                        <h2 class="text-base md:text-lg font-bold text-white">${diagnosis.boreholeId}</h2>
                        <div class="text-[10px] text-indigo-200 mt-0.5">座標: ${diagnosis.lat.toFixed(4)}, ${diagnosis.lng.toFixed(4)}</div>
                        <div class="text-[9px] text-indigo-300/80 mt-1">${rainfall?.timelineLabel || ''}</div>
                    </div>
                    <div class="text-center bg-white/10 backdrop-blur px-3 py-1.5 rounded-lg border border-white/20">
                        <div class="text-[9px] text-indigo-200">総合安全度</div>
                        <div class="text-xl font-black text-white flex items-center justify-center gap-1">
                            <span>ランク</span>
                            <span class="text-yellow-300 font-extrabold text-2xl">${diagnosis.overallRank}</span>
                        </div>
                        <div class="text-[10px] text-white/80 font-medium">${scores.overall}/100点</div>
                    </div>
                </div>

                <!-- 広島防災WEB 4大降雨実測値 カード -->
                <div class="bg-gradient-to-r from-blue-50 via-slate-50 to-indigo-50 border border-blue-200 p-3 rounded-xl space-y-2">
                    <div class="flex justify-between items-center border-b border-blue-200/60 pb-1.5">
                        <span class="text-xs font-bold text-blue-950 flex items-center gap-1">
                            <span>🌧</span> 広島防災WEB 実測降雨ハザード診断
                        </span>
                        <span class="text-[10px] px-2 py-0.5 rounded text-white font-bold" style="background-color: ${cumLvlObj.color};">
                            ${cumLvlObj.short}
                        </span>
                    </div>

                    <!-- 4指標グリッド -->
                    <div class="grid grid-cols-2 gap-2 text-xs">
                        <!-- 降り始めからの累加雨量 -->
                        <div class="p-2 bg-white rounded-lg border border-blue-100 shadow-2xs">
                            <span class="text-[10px] text-gray-500 block">降り始め累加雨量:</span>
                            <div class="text-base font-black text-blue-700 mt-0.5">
                                ${cum} <span class="text-[10px] font-normal text-gray-600">mm</span>
                            </div>
                            <div class="text-[9px] text-gray-400">飽和危険: 200mm〜</div>
                        </div>

                        <!-- 実効雨量 R' -->
                        <div class="p-2 bg-white rounded-lg border border-blue-100 shadow-2xs">
                            <span class="text-[10px] text-gray-500 block">実効雨量 R' (土砂指標):</span>
                            <div class="text-base font-black mt-0.5" style="color: ${rLvlObj.color};">
                                ${rprime} <span class="text-[10px] font-normal text-gray-500">(/250)</span>
                            </div>
                            <div class="text-[9px] text-gray-400">避難指示: 250〜</div>
                        </div>

                        <!-- 60分雨量 -->
                        <div class="p-2 bg-white rounded-lg border border-slate-100 shadow-2xs">
                            <span class="text-[10px] text-gray-500 block">60分間雨量 (短時間強度):</span>
                            <div class="text-sm font-bold text-gray-800 mt-0.5">
                                ${max60} <span class="text-[10px] font-normal text-gray-600">mm/h</span>
                            </div>
                            <div class="text-[9px] text-gray-400">激しい雨: 30mm/h〜</div>
                        </div>

                        <!-- 24時間雨量 -->
                        <div class="p-2 bg-white rounded-lg border border-slate-100 shadow-2xs">
                            <span class="text-[10px] text-gray-500 block">24時間雨量:</span>
                            <div class="text-sm font-bold text-gray-800 mt-0.5">
                                ${max24} <span class="text-[10px] font-normal text-gray-600">mm/24h</span>
                            </div>
                            <div class="text-[9px] text-gray-400">災害採択: 80mm〜</div>
                        </div>
                    </div>

                    <div class="text-[10px] text-blue-900 pt-1 flex justify-between">
                        <span>最寄り観測局: <strong>${near.city || ''} ${near.name || '-'}</strong> (第${near.row || '-'}行)</span>
                        <span>距離: ${near.distKm || 0}km</span>
                    </div>
                </div>

                <!-- 総合コメント -->
                <div class="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 leading-relaxed font-medium">
                    ${diagnosis.rankSummary}
                </div>

                <!-- レーダーチャート & 評価グリッド -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center bg-white p-3 border border-gray-200 rounded-xl">
                    <div class="flex justify-center items-center py-1">
                        ${renderRadarChartSvg(scores, 180)}
                    </div>
                    <div class="space-y-1.5 text-xs">
                        <div class="flex justify-between items-center p-1.5 bg-gray-50 rounded-lg">
                            <span class="text-gray-600 font-medium">地盤種別/増幅</span>
                            <span class="font-bold text-gray-800">${seismic.shakingCategory} (ARV=${seismic.arv})</span>
                        </div>
                        <div class="flex justify-between items-center p-1.5 bg-gray-50 rounded-lg">
                            <span class="text-gray-600 font-medium">液状化リスク</span>
                            <span class="font-bold" style="color: ${seismic.liqColor};">${seismic.liquefactionText}</span>
                        </div>
                        <div class="flex justify-between items-center p-1.5 bg-gray-50 rounded-lg">
                            <span class="text-gray-600 font-medium">実測R'値</span>
                            <span class="font-bold" style="color: ${rLvlObj.color};">
                                ${rprime} <span class="text-[10px] text-gray-500 font-normal">(${rLvlObj.short})</span>
                            </span>
                        </div>
                        <div class="flex justify-between items-center p-1.5 bg-gray-50 rounded-lg">
                            <span class="text-gray-600 font-medium">最寄り雨量局</span>
                            <span class="text-gray-800 font-medium">${near.city || ''} ${near.name || '-'} (${near.distKm || 0}km)</span>
                        </div>
                        <div class="flex justify-between items-center p-1.5 bg-gray-50 rounded-lg">
                            <span class="text-gray-600 font-medium">表層地質</span>
                            <span class="text-gray-800 font-medium">${diagnosis.surfaceSoil}</span>
                        </div>
                    </div>
                </div>

                <!-- 防災アクション・提言 -->
                <div class="space-y-2">
                    <h3 class="text-xs font-bold text-gray-700 uppercase tracking-wider">推奨される防災・避難アクション</h3>
                    <div class="space-y-2">
                        ${recommendations.map(r => `
                            <div class="p-2.5 rounded-lg border text-xs ${
                                r.type === 'urgent' ? 'bg-red-50 border-red-200 text-red-900' :
                                r.type === 'warning' ? 'bg-orange-50 border-orange-200 text-orange-900' :
                                r.type === 'info' ? 'bg-blue-50 border-blue-200 text-blue-900' :
                                'bg-emerald-50 border-emerald-200 text-emerald-900'
                            }">
                                <div class="font-bold text-xs mb-0.5 flex items-center gap-1.5">
                                    <span class="w-2 h-2 rounded-full ${
                                        r.type === 'urgent' ? 'bg-red-500' :
                                        r.type === 'warning' ? 'bg-orange-500' :
                                        r.type === 'info' ? 'bg-blue-500' : 'bg-emerald-500'
                                    }"></span>
                                    ${r.title}
                                </div>
                                <div class="leading-relaxed opacity-90 text-[11px]">${r.desc}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    return {
        diagnoseLocation,
        renderRadarChartSvg,
        buildCarteHtml
    };
})();
