/**
 * GioVision Hiroshima - Geological Cross-Section Viewer (地盤断面図ビューア)
 * (近隣複数ボーリング孔を結ぶ地層断面・N値プロファイルの自動描画モジュール)
 */

window.SectionViewer = (function () {
    const soilColors = {
        Sand: '#fcd34d',
        Clay: '#8b5cf6',
        Gravel: '#9ca3af',
        Rock: '#4b5563',
        Organic: '#10b981',
        Other: '#cbd5e1'
    };

    /**
     * 2点間距離 (m)
     */
    function distanceMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * 選択されたボーリング孔リストから断面図HTML/Canvasを描画
     * @param {Array} boreholes - ボーリング孔オブジェクトの配列
     */
    function renderSectionSvg(boreholes, width = 640, height = 320) {
        if (!boreholes || boreholes.length < 2) {
            return `
                <div class="p-8 text-center text-gray-400 text-xs">
                    <svg class="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                    </svg>
                    2地点以上のボーリング孔を選択すると<br>ここに地層断面図が自動生成されます
                </div>
            `;
        }

        // 最大深度を特定
        const maxDepth = Math.max(10, ...boreholes.map(b => b.depth || 10));
        const padding = { top: 40, right: 40, bottom: 40, left: 60 };
        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        // 孔ごとのX座標位置を計算（累積距離に比例）
        let totalDist = 0;
        const dists = [0];
        for (let i = 1; i < boreholes.length; i++) {
            const d = distanceMeters(boreholes[i - 1].lat, boreholes[i - 1].lng, boreholes[i].lat, boreholes[i].lng);
            totalDist += d;
            dists.push(totalDist);
        }

        const colWidth = 28;
        const xPositions = dists.map(d => {
            if (totalDist === 0) return padding.left + chartW / 2;
            return padding.left + (d / totalDist) * (chartW - colWidth) + colWidth / 2;
        });

        // 1. 深度目盛りとグリッド線
        let gridSvg = '';
        const depthStep = maxDepth <= 10 ? 2 : (maxDepth <= 25 ? 5 : 10);
        for (let d = 0; d <= maxDepth; d += depthStep) {
            const y = padding.top + (d / maxDepth) * chartH;
            gridSvg += `
                <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#f1f5f9" stroke-width="1" />
                <text x="${padding.left - 8}" y="${y + 3}" text-anchor="end" font-size="9" fill="#64748b">GL -${d}m</text>
            `;
        }

        // 2. 地層柱状図とN値バーの描画
        let columnsSvg = '';
        let groundwaterPoints = [];

        boreholes.forEach((bh, idx) => {
            const x = xPositions[idx];
            const layers = bh.layers || [];
            const bhDepth = bh.depth || 10;

            // 地表面ラベル (孔ID & 距離)
            const distLabel = idx === 0 ? '0m' : `${Math.round(dists[idx])}m`;
            columnsSvg += `
                <text x="${x}" y="${padding.top - 18}" text-anchor="middle" font-size="10" font-weight="bold" fill="#1e293b">${bh.id}</text>
                <text x="${x}" y="${padding.top - 6}" text-anchor="middle" font-size="8" fill="#64748b">${distLabel}</text>
            `;

            // 層セグメント
            layers.forEach(layer => {
                const sY = padding.top + (layer.startDepth / maxDepth) * chartH;
                const eY = padding.top + (layer.endDepth / maxDepth) * chartH;
                const lH = Math.max(1, eY - sY);
                const color = soilColors[layer.type] || soilColors.Other;

                // 柱状図矩形
                columnsSvg += `
                    <rect x="${x - colWidth / 2}" y="${sY}" width="${colWidth}" height="${lH}" fill="${color}" stroke="#cbd5e1" stroke-width="0.5" rx="1">
                        <title>${bh.id}: ${layer.rawName || layer.type} (GL -${layer.startDepth}m〜${layer.endDepth}m, N=${layer.nValue ?? '-'})</title>
                    </rect>
                `;

                // N値簡易バー (右側に小さくプロット)
                const n = layer.nValue ?? (layer.nIsRefusal ? 50 : 0);
                if (n > 0) {
                    const nBarW = Math.min(24, (n / 50) * 24);
                    const nY = sY + lH / 2;
                    columnsSvg += `
                        <line x1="${x + colWidth / 2 + 2}" y1="${nY}" x2="${x + colWidth / 2 + 2 + nBarW}" y2="${nY}" stroke="#ef4444" stroke-width="2" stroke-linecap="round" />
                        <text x="${x + colWidth / 2 + 4 + nBarW}" y="${nY + 2.5}" font-size="7" font-weight="bold" fill="#dc2626">${n}</text>
                    `;
                }
            });

            // 孔内水位
            const gw = bh.groundwater?.representative;
            if (gw != null && gw >= 0) {
                const gwY = padding.top + (gw / maxDepth) * chartH;
                groundwaterPoints.push({ x, y: gwY });
                columnsSvg += `
                    <polygon points="${x - 4},${gwY - 4} ${x + 4},${gwY - 4} ${x},${gwY + 2}" fill="#2563eb" />
                `;
            }
        });

        // 3. 地下水位線の接続
        let gwLineSvg = '';
        if (groundwaterPoints.length >= 2) {
            const pointsStr = groundwaterPoints.map(p => `${p.x},${p.y}`).join(' ');
            gwLineSvg = `
                <polyline points="${pointsStr}" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.85" />
            `;
        }

        return `
            <div class="bg-white rounded-xl p-3 border border-gray-200 shadow-sm overflow-x-auto">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                        <span class="w-2.5 h-2.5 rounded-sm bg-blue-600"></span>地層断面プロファイル (${boreholes.length}孔 / 総距離: ${Math.round(totalDist)}m)
                    </span>
                    <div class="flex items-center gap-2 text-[10px] text-gray-500">
                        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-amber-300"></span>砂質</span>
                        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-purple-500"></span>粘性</span>
                        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-gray-400"></span>礫</span>
                        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-gray-700"></span>岩盤</span>
                        <span class="flex items-center gap-1"><span class="w-2 h-0.5 bg-red-500"></span>N値</span>
                        <span class="flex items-center gap-1"><span class="w-2 h-0.5 border-t border-dashed border-blue-600"></span>孔内水位</span>
                    </div>
                </div>
                <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="mx-auto block font-sans">
                    ${gridSvg}
                    ${gwLineSvg}
                    ${columnsSvg}
                </svg>
            </div>
        `;
    }

    return {
        renderSectionSvg,
        distanceMeters
    };
})();
