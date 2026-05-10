// ==UserScript==
// @name         網頁快照上傳至 Azure Blob Storage
// @version      0.2.0
// @description  透過 Tampermonkey 選單將目前網頁製作成完全獨立的 HTML 快照（所有 CSS、圖片、字型均轉為 Data URI），並上傳至指定的 Azure Blob Storage，最後在新頁籤開啟純淨快照 URL
// @license      MIT
// @homepage     https://blog.miniasp.com/
// @homepageURL  https://blog.miniasp.com/
// @website      https://www.facebook.com/will.fans
// @source       https://github.com/doggy8088/TampermonkeyUserscripts/raw/main/src/SavePageToAzureBlob.user.js
// @namespace    https://github.com/doggy8088/TampermonkeyUserscripts/raw/main/src/SavePageToAzureBlob.user.js
// @author       Will Huang
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

// ============================================================
// == 首次使用設定說明 ==
// ============================================================
//
// 本腳本需要預先設定 Azure Blob Storage 的 Container SAS URL，
// 腳本才能將網頁快照上傳至您的 Azure Blob 容器。
//
// 【步驟一】建立 Azure Storage Account 與 Container
//   1. 登入 Azure Portal（https://portal.azure.com）
//   2. 建立或選擇已有的 Storage Account
//   3. 在 Storage Account 中建立一個 Blob Container（建議設為 Private）
//
// 【步驟二】產生 Container 層級的 SAS Token
//   方法 A：（建議）使用 Azure Portal UI
//     1. 進入 Storage Account > Data storage > Containers
//     2. 點擊目標 Container 右側的「...」> 選擇「Generate SAS」
//     3. 權限勾選：Create（c）、Write（w）（最小必要權限）
//     4. 設定適當的「Expiry」到期日
//     5. 點擊「Generate SAS token and URL」
//     6. 複製「Blob SAS URL」欄位（格式如下範例），勿複製「Blob SAS token」）
//
//   方法 B：使用 Azure CLI
//     az storage container generate-sas \
//       --account-name <ACCOUNT_NAME> \
//       --name <CONTAINER_NAME> \
//       --permissions cw \
//       --expiry 2027-12-31T00:00:00Z \
//       --https-only \
//       --output tsv
//     （上述指令僅輸出 SAS token，請自行組合完整 URL）
//
// 【步驟三】SAS URL 格式說明
//   取得的 Container SAS URL 格式如下：
//   https://<帳號>.blob.core.windows.net/<容器名>?sv=2023-11-03&ss=b&srt=sco&sp=cw&se=2027-01-01T00%3A00%3A00Z&sig=XXXXX
//
//   ※ 重要：本腳本需要的是「Container SAS URL」（路徑結尾是容器名，後接 ?sv=...），
//      而非單一 Blob 的 SAS URL（路徑包含檔案名稱）。
//
// 【步驟四】在 Tampermonkey 選單中設定 SAS URL
//   1. 在任意網頁點開瀏覽器工具列的 Tampermonkey 圖示
//   2. 選擇「⚙️ 設定 Azure Blob SAS URL」
//   3. 在彈出的對話框中貼上步驟二取得的 Container SAS URL
//   4. 點擊確定後，SAS URL 即儲存完成
//
// 【安全性說明】
//   SAS URL 透過 Tampermonkey 的 GM_setValue() 儲存，
//   資料保存在瀏覽器擴充套件的獨立儲存區，
//   網頁中的任何 JavaScript 均無法讀取此儲存區，
//   比存放在 localStorage 或 Cookie 中更為安全。
//   請勿將 SAS URL 分享給他人，並建議定期更換 SAS Token 以降低風險。
//
// 【使用方式】
//   在任意網頁點開 Tampermonkey 選單，選擇「📸 儲存網頁快照」，
//   腳本將依序執行：
//     1. 擷取目前頁面的完整渲染後 DOM 狀態
//     2. 將所有外部 CSS、字型、圖片、SVG 等資源轉換為 Data URI（內嵌進 HTML）
//     3. 組成一份完全獨立、無任何外部依賴的 HTML 文件
//     4. 使用 PUT 方式上傳至您的 Azure Blob Storage Container
//     5. 在新頁籤開啟上傳後的純淨 Blob URL（不含 SAS Token）
//
// 【注意事項】
//   - 若頁面資源非常多（如大量圖片），序列化過程可能需要數十秒，請耐心等待
//   - 超過 10MB 的單一資源將略過內嵌，改保留原始絕對 URL，避免 HTML 過大
//   - <script src="..."> 標籤的外部 JavaScript 不會被內嵌（已執行的 JS 邏輯已反映在 DOM 狀態中）
//   - <video> 和 <audio> 的媒體 src 不會被內嵌（通常體積過大），僅保留 poster 圖片
//   - <canvas> 元素會嘗試以 toDataURL() 轉換為 <img>，若有跨來源限制則略過
//   - Container 必須具備 Create + Write 兩項 SAS 權限，缺一不可
//
// ============================================================

(function () {
    'use strict';

    // ===== 腳本常數設定 =====

    // Tampermonkey 儲存鍵名，用於安全保存 SAS URL
    const SAS_URL_STORAGE_KEY = 'azureContainerSasUrl';

    // 由「右鍵 context-menu 觸發腳本」送出的事件名稱。
    // 透過 DOM CustomEvent 做跨 userscript 溝通，可避免複製整份快照邏輯。
    const CONTEXT_MENU_TRIGGER_EVENT = 'save-page-to-azure-blob:trigger';

    // 主腳本收到觸發事件後，會立即回送 ACK，
    // 讓 context-menu 腳本可判斷主腳本是否存在且可正常接手執行。
    const CONTEXT_MENU_ACK_EVENT = 'save-page-to-azure-blob:ack';

    // 單一資源超過此大小（位元組）時略過內嵌，改保留原始 URL，預設 10MB
    const MAX_INLINE_SIZE_BYTES = 10 * 1024 * 1024;

    // GM_xmlhttpRequest 請求逾時（毫秒），預設 30 秒
    const REQUEST_TIMEOUT_MS = 30000;

    // 防止同一頁面上的多個觸發來源在短時間內同時執行快照流程。
    // 這個腳本同時支援 Tampermonkey 選單與 context-menu 橋接事件，
    // 若瀏覽器或擴充套件在某些頁面上重複派發觸發，就可能造成多次上傳、
    // 多個成功訊息，以及多個新頁籤被連續開啟。
    // 透過「單一進行中作業鎖」可確保整個頁面在任一時間只會有一份快照作業。
    let activeSaveOperation = null;
    let activeStatusBar = null;

    // ===== 工具：Promise 化 GM_xmlhttpRequest =====

    /**
     * 將 GM_xmlhttpRequest 包裝成 Promise，
     * 統一處理 onload / onerror / ontimeout / onabort 回呼，
     * 讓後續程式碼可使用 async/await 語法。
     *
     * @param {object} options - 傳入 GM_xmlhttpRequest 的選項物件
     * @returns {Promise<object>} 解析後的 GM_xmlhttpRequest response 物件
     */
    function gmFetch(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: REQUEST_TIMEOUT_MS,
                ...options,
                onload(response) {
                    // HTTP 4xx / 5xx 仍會進 onload，依狀態碼判斷
                    if (response.status >= 200 && response.status < 400) {
                        resolve(response);
                    } else {
                        reject(new Error(`HTTP ${response.status}: ${options.url}`));
                    }
                },
                onerror(err)  { reject(new Error(`Network error: ${options.url} — ${JSON.stringify(err)}`)); },
                ontimeout()   { reject(new Error(`Timeout: ${options.url}`)); },
                onabort()     { reject(new Error(`Aborted: ${options.url}`)); }
            });
        });
    }

    /**
     * 簡單的 Promise 延遲工具。
     *
     * 設計意圖：
     *   - 讓原本以 setTimeout() 實作的「延後開新頁籤」可被 await，
     *     使主流程的生命週期更完整、也更容易被防重入鎖正確涵蓋。
     *   - 只有當延遲結束且開頁邏輯完成後，才釋放 activeSaveOperation，
     *     避免短時間內再次觸發時又啟動第二輪上傳。
     *
     * @param {number} ms - 要等待的毫秒數
     * @returns {Promise<void>} 延遲完成後 resolve
     */
    function delay(ms) {
        return new Promise(resolve => {
            window.setTimeout(resolve, ms);
        });
    }

    // ===== 工具：從 responseHeaders 字串解析 Content-Type =====

    /**
     * 從 GM_xmlhttpRequest 的 responseHeaders 字串中抽取 MIME type，
     * 剝除 charset 等參數，只回傳純粹的 MIME type 字串，例如 "image/png"。
     *
     * @param {string} headers - HTTP response headers 的原始字串
     * @returns {string} 解析到的 MIME type，或空字串（解析失敗時）
     */
    function parseMimeType(headers) {
        const line = (headers || '').split('\n').find(h => h.toLowerCase().startsWith('content-type:'));
        if (!line) return '';
        const value = line.split(':').slice(1).join(':').trim();
        return value.split(';')[0].trim();
    }

    // ===== 工具：依副檔名猜測 MIME type（作為 Content-Type 解析失敗時的後備）=====

    /**
     * 當 HTTP 回應標頭缺少 Content-Type 時，
     * 根據 URL 副檔名推測資源的 MIME type，以確保 Data URI 格式正確。
     *
     * @param {string} url - 資源的 URL 字串
     * @returns {string} 推測的 MIME type，預設為 "application/octet-stream"
     */
    function guessMimeType(url) {
        const ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
        const map = {
            // 圖片
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
            svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
            // 字型
            woff: 'font/woff', woff2: 'font/woff2',
            ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
            // 樣式與文件
            css: 'text/css', js: 'application/javascript',
            json: 'application/json', html: 'text/html', xml: 'text/xml',
            // 其他
            pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm'
        };
        return map[ext] || 'application/octet-stream';
    }

    // ===== 核心：將外部 URL 資源轉換為 base64 Data URI =====

    /**
     * 透過 GM_xmlhttpRequest（繞過 CORS 限制）抓取指定 URL 的資源，
     * 將其轉換為 base64 Data URI 格式，使資源可完整內嵌於 HTML 文件中。
     *
     * 若資源超過 MAX_INLINE_SIZE_BYTES（預設 10MB），
     * 或抓取失敗（網路錯誤、逾時、HTTP 錯誤等），
     * 將直接回傳原始絕對 URL，確保頁面仍可正常顯示。
     *
     * @param {string} url      - 欲轉換的資源 URL（可為相對路徑）
     * @param {string} baseUrl  - 解析相對 URL 時使用的基準 URL，預設為 location.href
     * @returns {Promise<string>} Data URI 字串，或原始絕對 URL（轉換失敗時）
     */
    async function toDataUri(url, baseUrl) {
        if (!url) return url;

        // 已是 Data URI，直接回傳
        if (url.startsWith('data:')) return url;

        // 解析為絕對 URL，若格式錯誤則略過
        let absoluteUrl;
        try {
            absoluteUrl = new URL(url, baseUrl || location.href).href;
        } catch {
            return url;
        }

        // blob: URL 屬於另一個 origin，GM_xmlhttpRequest 無法跨域取得，直接略過
        if (absoluteUrl.startsWith('blob:')) return absoluteUrl;

        try {
            const response = await gmFetch({
                method: 'GET',
                url: absoluteUrl,
                responseType: 'arraybuffer'
            });

            // 確認資源大小在可接受範圍
            if (response.response.byteLength > MAX_INLINE_SIZE_BYTES) {
                console.warn(`[SavePageToAzureBlob] 資源超過大小上限，略過內嵌：${absoluteUrl}`);
                return absoluteUrl;
            }

            const mimeType = parseMimeType(response.responseHeaders) || guessMimeType(absoluteUrl);
            const bytes = new Uint8Array(response.response);

            // 使用分塊方式轉換，避免超大陣列展開時發生 call stack overflow
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
            }

            return `data:${mimeType};base64,${btoa(binary)}`;
        } catch (err) {
            // 任何錯誤皆降級為保留原始絕對 URL
            console.warn(`[SavePageToAzureBlob] 無法轉換資源（${err.message}）：${absoluteUrl}`);
            return absoluteUrl;
        }
    }

    // ===== 核心：遞迴內嵌 CSS 文字中的所有外部資源 =====

    /**
     * 分析 CSS 文字中的所有 @import 規則與 url() 函式，
     * 並將它們全部替換為對應的 Data URI 或內嵌 CSS 文字，
     * 達成 CSS 文件的完全自包含（self-contained）。
     *
     * 處理順序：先解析 @import（遞迴），再處理 url()，
     * 確保 @import 引入的 CSS 中的 url() 也會被一併處理。
     *
     * @param {string} cssText - 待處理的 CSS 文字內容
     * @param {string} baseUrl - 解析 CSS 中相對路徑所使用的基準 URL
     * @returns {Promise<string>} 所有資源皆內嵌後的 CSS 文字
     */
    async function inlineCssResources(cssText, baseUrl) {
        // ── 第一步：展開 @import 規則（遞迴處理） ──
        // 比對兩種語法：@import url("...") 與 @import "..."
        const importRegex = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/g;
        const importMatches = [...cssText.matchAll(importRegex)];

        for (const match of importMatches) {
            // 取出 import 的 URL（url() 語法存在 match[2]，引號語法存在 match[4]）
            const importedUrl = match[2] || match[4];
            const mediaQuery = match[5] ? match[5].trim() : '';

            try {
                const absUrl = new URL(importedUrl, baseUrl).href;
                const importedCssResponse = await gmFetch({ method: 'GET', url: absUrl, responseType: 'text' });
                // 遞迴處理引入的 CSS，並以其絕對 URL 作為新的 baseUrl
                let importedCss = await inlineCssResources(importedCssResponse.responseText, absUrl);

                // 若原本有 media query，用 @media 包裝引入的 CSS
                if (mediaQuery) {
                    importedCss = `@media ${mediaQuery} {\n${importedCss}\n}`;
                }
                cssText = cssText.replace(match[0], importedCss);
            } catch (err) {
                // @import 展開失敗時保留原始宣告，不中斷整體處理
                console.warn(`[SavePageToAzureBlob] @import 展開失敗（${err.message}）：${importedUrl}`);
            }
        }

        // ── 第二步：將 url() 中的所有外部資源替換為 Data URI ──
        // 比對 url('...') 與 url("...") 與 url(...) 三種語法
        const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
        const urlMatches = [...cssText.matchAll(urlRegex)];

        for (const match of urlMatches) {
            const resourceUrl = match[2].trim();
            // 已是 Data URI，跳過
            if (resourceUrl.startsWith('data:')) continue;

            const dataUri = await toDataUri(resourceUrl, baseUrl);
            // 僅在成功轉換時（回傳 Data URI 而非原始 URL）才進行替換，確保冪等性
            if (dataUri !== resourceUrl && !dataUri.startsWith(resourceUrl)) {
                cssText = cssText.replace(match[0], `url("${dataUri}")`);
            }
        }

        return cssText;
    }

    // ===== 核心：序列化當前頁面為完全獨立的 HTML 字串 =====

    /**
     * 對當前頁面執行完整的 DOM 序列化，
     * 並將所有外部資源（樣式表、圖片、字型、SVG 背景等）轉換為 Data URI，
     * 最終產出一份可完全離線瀏覽的獨立 HTML 文件字串。
     *
     * 處理項目：
     *   - <link rel="stylesheet"> → 抓取並內嵌為 <style>
     *   - <style> 塊內的 url() → 轉換為 Data URI
     *   - <img src> / <img srcset> → src 轉 Data URI，srcset 清除（避免瀏覽器使用外部源）
     *   - <video poster> / <audio> → poster 圖轉 Data URI，src 保留原始絕對 URL（媒體體積過大）
     *   - <canvas> → 嘗試以 toDataURL() 轉為 <img>（跨域受限時略過）
     *   - <input>/<textarea>/<select> → 將當前表單值寫回 value/checked 屬性
     *   - <link rel="icon"> 系列 → href 轉 Data URI
     *   - <link rel="preload"> / <link rel="prefetch"> → 移除（離線版不需要）
     *   - <script src> → 移除 src（保留標籤以免影響後續 DOM 結構，但不內嵌 JS）
     *   - <base href> → 移除（已全部使用絕對 URL，不需要 base 標籤）
     *   - style 屬性中的 url() → 轉換為 Data URI
     *
     * @param {function} onProgress - 進度回呼，接受 (current, total, message) 三個參數
     * @returns {Promise<string>} 完整的 HTML 字串（含 <!DOCTYPE html> 宣告）
     */
    async function serializePage(onProgress) {
        const pageUrl = location.href;

        /**
         * 將相對 URL 轉為基於原始頁面的絕對 URL，必要時保留「#」書籤連結。
         *
         * 設計意圖：
         *   - 快照頁面已脫離原站點，若保留相對網址會導致連結失效或導向錯誤。
         *   - 透過 URL(base) 正確處理 ./、../、?query、//host 等邊界情境。
         *   - 對於 <a href="#hash"> 這類頁內書籤連結，必須保留為相對形式，
         *     否則會被解析為原站點 URL，造成跳離快照頁面。
         *
         * @param {string|null} rawUrl - 原始屬性值（href 或 action）
         * @param {string} baseUrl - 解析相對路徑的基準 URL（原始頁面 URL）
         * @param {boolean} preserveHashOnly - 是否保留純 #hash 連結為原樣
         * @returns {string|null} 轉換後的 URL 或原始值
         */
        function toAbsoluteUrlIfRelative(rawUrl, baseUrl, preserveHashOnly) {
            if (rawUrl === null || rawUrl === undefined) return rawUrl;

            const trimmed = rawUrl.trim();
            if (!trimmed) return rawUrl;

            if (preserveHashOnly && trimmed.startsWith('#')) {
                return trimmed;
            }

            // 若已有協定（http:、https:、mailto:、javascript:、data:...），視為絕對 URL，維持原樣。
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
                return rawUrl;
            }

            try {
                return new URL(trimmed, baseUrl).href;
            } catch {
                // 解析失敗時維持原狀，避免破壞未知格式
                return rawUrl;
            }
        }

        // ── 預處理：將 <canvas> 元素轉為 <img>（需在 clone 之前，在原始 DOM 上操作）──
        // cloneNode 無法複製 canvas 的像素資料，因此需要先將 canvas 繪製內容轉為 Data URI，
        // 再建立對應的 <img> 元素供後續序列化使用。
        const canvasMap = new Map();
        document.querySelectorAll('canvas').forEach((canvas, index) => {
            try {
                // toDataURL() 在跨域 canvas（tainted canvas）上會拋出 SecurityError
                const dataUri = canvas.toDataURL('image/png');
                canvasMap.set(index, dataUri);
            } catch {
                // 略過跨域受污染的 canvas
            }
        });

        // ── 將當前表單值對應到 DOM 屬性（clone 之前先埋值）──
        // cloneNode(true) 複製 DOM 屬性，但不複製 JS property（.value / .checked），
        // 因此需先將當前值寫回屬性，才能確保 clone 後的快照保留使用者輸入內容。
        document.querySelectorAll('input, textarea, select').forEach(el => {
            if (el.tagName === 'INPUT') {
                if (el.type === 'checkbox' || el.type === 'radio') {
                    el.checked ? el.setAttribute('checked', '') : el.removeAttribute('checked');
                } else {
                    el.setAttribute('value', el.value);
                }
            } else if (el.tagName === 'TEXTAREA') {
                el.textContent = el.value;
            } else if (el.tagName === 'SELECT') {
                // 為每個 <option> 同步 selected 屬性
                Array.from(el.options).forEach(opt => {
                    opt.selected ? opt.setAttribute('selected', '') : opt.removeAttribute('selected');
                });
            }
        });

        // ── 深度克隆整個 <html> 節點，後續所有修改都在 clone 上進行，不影響原始頁面 ──
        const root = document.documentElement.cloneNode(true);

        // ── 移除快照工具自身注入的狀態提示條（不應出現在最終快照中）──
        // 狀態提示條在序列化開始前就已插入 document.body，
        // cloneNode(true) 會將其一併複製，因此需在此處主動刪除，
        // 避免瀏覽器工具列 UI 汙染使用者看到的快照內容。
        root.querySelector('#__save_azure_status_bar__')?.remove();

        // ── 在 clone 中替換 canvas → img ──
        const clonedCanvases = root.querySelectorAll('canvas');
        clonedCanvases.forEach((canvas, index) => {
            const dataUri = canvasMap.get(index);
            if (!dataUri) return;
            const img = document.createElement('img');
            img.src = dataUri;
            img.width  = canvas.width;
            img.height = canvas.height;
            img.style.cssText = canvas.style.cssText || '';
            canvas.parentNode?.replaceChild(img, canvas);
        });

        // ── 移除原始 <base href>（避免相對連結解析到不正確的基準）──
        // 設計意圖：
        //   1) 原始頁面可能有 <base> 指到子路徑或 CDN，快照中會造成相對連結失效。
        //   2) 我們稍後會「明確改寫」<a href> 與 <form action> 的相對網址成絕對網址，
        //      這樣就不需要依賴 <base>，也能避免 #hash 書籤連結被導向回原網站。
        root.querySelectorAll('base').forEach(el => el.remove());

        // ── 移除 <link rel="preload"> / <link rel="prefetch">（快照不需要預載資源）──
        root.querySelectorAll('link[rel="preload"], link[rel="prefetch"]').forEach(el => el.remove());

        // ── 移除 <script src> 的 src 屬性（保留標籤結構，但不內嵌外部 JS 邏輯）──
        // 理由：外部 JS 通常體積龐大，且快照的 DOM 狀態已是 JS 執行後的結果，
        // 重新執行 JS 可能反而破壞快照的靜態呈現。
        root.querySelectorAll('script[src]').forEach(el => {
            el.removeAttribute('src');
            el.removeAttribute('type'); // 避免瀏覽器嘗試解譯空的 module script
            el.textContent = '/* external script removed by SavePageToAzureBlob */';
        });

        // ── 蒐集所有 <link rel="stylesheet"> 準備進行抓取與內嵌 ──
        const styleLinks = [...root.querySelectorAll('link[rel="stylesheet"][href]')];

        // ── 蒐集所有 <style> 元素準備處理內部 url() ──
        const styleElements = [...root.querySelectorAll('style')];

        // ── 蒐集需要轉換 src 的圖片 / 媒體元素 ──
        const imgElements    = [...root.querySelectorAll('img[src]')];
        const videoPosterEls = [...root.querySelectorAll('video[poster]')];
        const iconLinks      = [...root.querySelectorAll('link[rel*="icon"][href]')];
        const elementsWithStyleAttr = [...root.querySelectorAll('[style]')];

        // ── 計算進度總量（用於顯示進度通知）──
        const total = styleLinks.length + styleElements.length + imgElements.length +
                      videoPosterEls.length + iconLinks.length;
        let current = 0;

        const progress = (msg) => {
            current++;
            onProgress?.(current, total, msg);
        };

        // ── 處理 <link rel="stylesheet"> → 抓取並展開為 <style> ──
        for (const link of styleLinks) {
            const href = link.href || link.getAttribute('href');
            if (!href) continue;
            try {
                const absHref = new URL(href, pageUrl).href;
                const response = await gmFetch({ method: 'GET', url: absHref, responseType: 'text' });
                const inlinedCss = await inlineCssResources(response.responseText, absHref);
                const styleEl = document.createElement('style');
                styleEl.textContent = inlinedCss;
                // 保留 media 屬性（如 media="print"）
                if (link.media) styleEl.setAttribute('media', link.media);
                link.parentNode?.replaceChild(styleEl, link);
            } catch (err) {
                // 抓取失敗時將 href 改為絕對 URL，確保即使無法內嵌仍能連線載入
                try {
                    link.href = new URL(href, pageUrl).href;
                } catch { /* 無效 URL，保留原樣 */ }
                console.warn(`[SavePageToAzureBlob] 樣式表內嵌失敗（${err.message}）：${href}`);
            }
            progress(`處理樣式表：${href.split('/').pop()}`);
        }

        // ── 處理 <style> 塊中的 url() ──
        for (const styleEl of styleElements) {
            try {
                styleEl.textContent = await inlineCssResources(styleEl.textContent, pageUrl);
            } catch (err) {
                console.warn(`[SavePageToAzureBlob] <style> 處理失敗：${err.message}`);
            }
            progress('處理內嵌樣式');
        }

        // ── 處理 <img src> 與 srcset ──
        for (const img of imgElements) {
            const src = img.getAttribute('src');
            if (src) {
                img.setAttribute('src', await toDataUri(src, pageUrl));
            }
            // srcset 含多個候選 URL，全部清除以確保瀏覽器只使用已內嵌的 src
            img.removeAttribute('srcset');
            // <picture> 中的 <source> 也一並清除
            img.closest('picture')?.querySelectorAll('source').forEach(s => {
                s.removeAttribute('srcset');
                s.removeAttribute('src');
            });
            progress(`處理圖片：${src?.split('/').pop()?.substring(0, 30)}`);
        }

        // ── 處理 <video poster> ──
        for (const video of videoPosterEls) {
            const poster = video.getAttribute('poster');
            if (poster) {
                video.setAttribute('poster', await toDataUri(poster, pageUrl));
            }
            // video / audio 的 src 不內嵌（媒體體積通常過大），改為絕對 URL 保留連結
            const mediaSrc = video.getAttribute('src');
            if (mediaSrc) {
                try { video.setAttribute('src', new URL(mediaSrc, pageUrl).href); } catch { /* 略過 */ }
            }
            progress(`處理影片封面：${poster?.split('/').pop()}`);
        }

        // ── 處理 <link rel="icon"> 系列圖示 ──
        for (const link of iconLinks) {
            const href = link.getAttribute('href');
            if (href) {
                link.setAttribute('href', await toDataUri(href, pageUrl));
            }
            progress(`處理網站圖示：${href?.split('/').pop()}`);
        }

        // ── 處理 style 屬性中的 url()（例如 background-image: url(...)）──
        for (const el of elementsWithStyleAttr) {
            const styleValue = el.getAttribute('style');
            if (styleValue && styleValue.includes('url(')) {
                el.setAttribute('style', await inlineCssResources(styleValue, pageUrl));
            }
        }

        // ── 修正 <a>/<area> 與 <form> 的相對網址為原頁面絕對網址 ──
        // 設計意圖：
        //   - 避免快照頁面脫離原站點後，相對連結失效。
        //   - 特別保留 "#hash" 這種頁內書籤連結，確保仍能在快照內跳轉。
        const anchorLikeElements = [...root.querySelectorAll('a[href], area[href]')];
        for (const el of anchorLikeElements) {
            const href = el.getAttribute('href');
            const absoluteHref = toAbsoluteUrlIfRelative(href, pageUrl, true);
            if (absoluteHref && absoluteHref !== href) {
                el.setAttribute('href', absoluteHref);
            }
        }

        const formElements = [...root.querySelectorAll('form[action]')];
        for (const form of formElements) {
            const action = form.getAttribute('action');
            const absoluteAction = toAbsoluteUrlIfRelative(action, pageUrl, false);
            if (absoluteAction && absoluteAction !== action) {
                form.setAttribute('action', absoluteAction);
            }
        }

        // ── 在快照頁面左下角加入「原始頁面」連結（僅影響快照，不影響原頁）──
        // 設計意圖與取捨說明：
        //   - 讓快照頁面永遠保留一條回到來源頁的低干擾入口，避免使用者無法追溯原始內容。
        //   - 使用 fixed 定位與高 z-index，確保無論捲動或頁面佈局如何都固定在左下角可點擊。
        //   - 以單一「🔗」字元 + 低透明度呈現，視覺存在感低，不影響閱讀主體。
        //   - 透過 inline style + !important 降低被站點 CSS 覆寫的機率，確保「無底線」與「指標手勢」一致。
        const body = root.querySelector('body');
        if (body) {
            const sourceLink = document.createElement('a');
            sourceLink.id = '__snapshot_source_link__';
            sourceLink.textContent = '🔗';
            sourceLink.setAttribute('href', pageUrl);
            sourceLink.setAttribute('target', '_blank');
            sourceLink.setAttribute('rel', 'noopener noreferrer');
            sourceLink.setAttribute('title', pageUrl);
            sourceLink.setAttribute('style', [
                'position: fixed',
                'left: 8px',
                'bottom: 8px',
                'z-index: 2147483647',
                'font-size: 14px',
                'line-height: 1',
                'opacity: 0.25',
                'text-decoration: none !important',
                'cursor: pointer',
                'user-select: none'
            ].join('; '));
            body.appendChild(sourceLink);
        }

        // ── 組合最終 HTML 字串，並補充 <!DOCTYPE html> / <meta charset> ──

        const head = root.querySelector('head');

        if (head) {
            // 確保 <head> 中有 charset 宣告，避免儲存後開啟出現亂碼
            // 同時將 meta charset 移到最前方，保證解碼指示在文件一開始就被解析。
            let metaCharset = head.querySelector('meta[charset]');
            if (!metaCharset) {
                metaCharset = document.createElement('meta');
                metaCharset.setAttribute('charset', 'utf-8');
            }
            if (head.firstChild !== metaCharset) {
                head.insertBefore(metaCharset, head.firstChild);
            }
        }

        // 加入標示此頁面為快照的 meta 標籤，方便識別
        if (head) {
            const metaSnapshot = document.createElement('meta');
            metaSnapshot.setAttribute('name', 'snapshot-source');
            metaSnapshot.setAttribute('content', pageUrl);
            metaSnapshot.setAttribute('data-snapshot-time', new Date().toISOString());
            head.appendChild(metaSnapshot);
        }

        return `<!DOCTYPE html>\n${root.outerHTML}`;
    }

    // ===== 核心：將 HTML 字串上傳至 Azure Blob Storage =====

    /**
     * 使用 Azure Blob Storage REST API（PUT Blob）將 HTML 文件上傳至指定容器，
     * 並回傳上傳後的純淨 Blob URL（不含 SAS Token 參數）。
     *
     * 上傳流程：
     *   1. 解析 Container SAS URL，分離出基礎 URL 與 SAS Token 查詢字串
     *   2. 依據當前網站 hostname 與時間戳記產生唯一的 Blob 檔案名稱
     *   3. 組合完整的 Blob PUT URL（含 SAS Token）
     *   4. 透過 GM_xmlhttpRequest 以 PUT 方式上傳 HTML 內容
     *   5. 回傳不含 SAS Token 的純淨 Blob URL
     *
     * @param {string} htmlContent  - 待上傳的 HTML 字串
     * @param {string} sasUrl       - Container 層級的 Azure Blob SAS URL
     * @returns {Promise<string>} 純淨的 Blob URL（不含 SAS Token 查詢參數）
     */
    async function uploadToAzureBlob(htmlContent, sasUrl) {
        // 解析 SAS URL，分離 origin+pathname（容器路徑）與 search（SAS Token 參數）
        let parsedSasUrl;
        try {
            parsedSasUrl = new URL(sasUrl);
        } catch {
            throw new Error('SAS URL 格式無效，請重新設定。');
        }

        // 去除 pathname 尾端的斜線
        const containerPath = parsedSasUrl.origin + parsedSasUrl.pathname.replace(/\/+$/, '');
        const sasQueryString = parsedSasUrl.search; // 包含 ? 的查詢字串，例如 ?sv=...&sig=...

        // 產生唯一的 Blob 檔案名稱：snapshot-{hostname}-{YYYYMMDD-HHmmss}.html
        const now = new Date();
        const timestamp = now.getFullYear().toString() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') + '-' +
            String(now.getHours()).padStart(2, '0') +
            String(now.getMinutes()).padStart(2, '0') +
            String(now.getSeconds()).padStart(2, '0');
        const hostname = location.hostname.replace(/[^a-zA-Z0-9.-]/g, '_') || 'unknown';
        const blobName = `snapshot-${hostname}-${timestamp}.html`;

        // 組合上傳用 URL（含 SAS Token）與純淨 URL（不含 SAS Token）
        const uploadUrl = `${containerPath}/${blobName}${sasQueryString}`;
        const cleanUrl  = `${containerPath}/${blobName}`;

        // 將 HTML 字串轉為 Uint8Array，取得精確 Content-Length（UTF-8 位元組數）
        const encoder = new TextEncoder();
        const htmlBytes = encoder.encode(htmlContent);

        // 使用 Azure Blob Storage REST API PUT Blob
        // 必要 Header：
        //   x-ms-blob-type: BlockBlob  → 指定 Blob 類型（必需）
        //   Content-Type               → 讓瀏覽器正確解析下載的 Blob
        //   x-ms-date                  → RFC1123 格式的請求時間（部分 SAS 設定需要）
        await gmFetch({
            method: 'PUT',
            url: uploadUrl,
            responseType: 'text',
            headers: {
                'x-ms-blob-type': 'BlockBlob',
                'Content-Type':   'text/html; charset=utf-8',
                'x-ms-version':   '2020-08-04',
                'x-ms-date':      new Date().toUTCString(),
                'Content-Length': String(htmlBytes.byteLength)
            },
            // GM_xmlhttpRequest 傳送 ArrayBuffer 以確保 UTF-8 字元正確傳輸
            data: htmlBytes.buffer
        });

        return cleanUrl;
    }

    // ===== UI：顯示浮動狀態提示條 =====

    /**
     * 在畫面右下角顯示一個半透明的狀態提示條，
     * 用於在快照擷取與上傳過程中提供即時的進度回饋。
     * 回傳一個物件，包含 update() 更新訊息與 remove() 移除提示條兩個方法。
     *
     * @param {string} initialMessage - 初始顯示的訊息
     * @returns {{ update: function(string): void, remove: function(): void }}
     */
    function createStatusBar(initialMessage) {
        const bar = document.createElement('div');
        bar.id = '__save_azure_status_bar__';

        // 使用高 z-index 確保提示條顯示在所有頁面元素之上
        Object.assign(bar.style, {
            position:     'fixed',
            bottom:       '20px',
            right:        '20px',
            zIndex:       '2147483647',
            padding:      '10px 16px',
            background:   'rgba(0, 0, 0, 0.82)',
            color:        '#fff',
            fontSize:     '13px',
            lineHeight:   '1.5',
            borderRadius: '6px',
            boxShadow:    '0 4px 12px rgba(0,0,0,0.4)',
            maxWidth:     '380px',
            wordBreak:    'break-all',
            fontFamily:   'system-ui, sans-serif',
            pointerEvents:'none'
        });

        bar.textContent = initialMessage;
        document.body.appendChild(bar);

        return {
            update: (msg) => { bar.textContent = msg; },
            remove: () => { bar.remove(); }
        };
    }

    /**
     * 在上傳成功後才開啟快照頁籤，確保使用者停留在原頁面等待進度，
     * 並避免因為「先開 about:blank 佔位」導致瀏覽器立即切換分頁。
     *
     * 設計取捨說明：
     *   - 若使用 window.open() 在非同步流程中開新頁籤，多數瀏覽器會直接封鎖。
     *   - Tampermonkey 的 GM_openInTab() 屬於特權 API，可在非同步流程中穩定開分頁，
     *     且能設定 active: true 以便在「上傳成功」時才切換過去。
     *   - 若 GM_openInTab 不可用（例如在非 Tampermonkey 環境），
     *     退回 window.open()，並以 best-effort 方式 focus 新分頁。
     *
     * @param {string} url - 上傳後的乾淨快照 URL（不含 SAS Token）
     * @returns {object|null} GM_openInTab 的 tab 物件或 window 物件（可能為 null）
     */
    function openSnapshotTab(url) {
        if (typeof GM_openInTab === 'function') {
            return GM_openInTab(url, {
                active: true,
                insert: true,
                setParent: true
            });
        }

        const newTab = window.open(url, '_blank');
        if (newTab) {
            try {
                newTab.focus();
            } catch {
                // focus 失敗時不影響主流程，讓使用者手動切換
            }
        }
        return newTab;
    }

    // ===== 主流程：「📸 儲存網頁快照」選單功能 =====

    /**
     * 主要執行流程，依序完成以下工作：
     *   1. 讀取已儲存的 SAS URL，如果尚未設定則提示使用者先設定
     *   2. 顯示進度提示條
     *   3. 序列化當前頁面（轉換所有外部資源為 Data URI）
     *   4. 上傳 HTML 至 Azure Blob Storage
     *   5. 在新頁籤開啟純淨的 Blob URL
     */
    async function savePageToAzureBlob() {
        if (activeSaveOperation) {
            // 直接重用既有作業，而不是再啟動第二份快照流程。
            // 這可避免同一頁面因重複事件或連點而開出多個空白分頁。
            activeStatusBar?.update('⏳ 已有進行中的快照作業，忽略重複觸發...');
            console.warn('[SavePageToAzureBlob] 偵測到重複觸發，已忽略新的快照要求。');
            return activeSaveOperation;
        }

        // 讀取已儲存的 SAS URL
        const sasUrl = GM_getValue(SAS_URL_STORAGE_KEY, '');
        if (!sasUrl) {
            alert('尚未設定 Azure Blob SAS URL。\n請先點選 Tampermonkey 選單中的「⚙️ 設定 Azure Blob SAS URL」。');
            return;
        }

        const statusBar = createStatusBar('🔄 正在擷取頁面資源，請稍候...');
        activeStatusBar = statusBar;

        activeSaveOperation = (async () => {
            try {
                // ── 序列化頁面（資源內嵌）──
                const htmlContent = await serializePage((current, total, msg) => {
                    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
                    statusBar.update(`🔄 處理中 ${pct}%（${current}/${total}）\n${msg}`);
                });

                const sizeKb = Math.round(new TextEncoder().encode(htmlContent).byteLength / 1024);
                statusBar.update(`📤 正在上傳（${sizeKb.toLocaleString()} KB），請稍候...`);

                // ── 上傳至 Azure Blob ──
                const cleanUrl = await uploadToAzureBlob(htmlContent, sasUrl);

                statusBar.update(`✅ 上傳成功！即將切換至快照頁籤...\n${cleanUrl}`);

                // 稍作延遲讓使用者看到成功訊息後，再開啟快照頁籤並切換過去，
                // 符合「保留在原頁等待上傳完成」的使用體驗。
                await delay(2000);

                const openedTab = openSnapshotTab(cleanUrl);
                if (!openedTab) {
                    statusBar.update(`✅ 上傳成功，但新頁籤被瀏覽器封鎖。\n請允許彈出式視窗或手動開啟：\n${cleanUrl}`);
                    await delay(6000);
                    return;
                }
            } catch (err) {
                // 擷取或上傳失敗時顯示錯誤，並提供複製建議
                statusBar.update(`❌ 操作失敗：${err.message}`);
                console.error('[SavePageToAzureBlob] 操作失敗：', err);
                await delay(6000);
            } finally {
                statusBar.remove();
            }
        })().finally(() => {
            activeSaveOperation = null;
            activeStatusBar = null;
        });

        return activeSaveOperation;
    }

    // ===== 設定流程：「⚙️ 設定 Azure Blob SAS URL」選單功能 =====

    /**
     * 讓使用者透過 prompt() 對話框輸入或更新 Azure Container SAS URL，
     * 並進行基本格式驗證後，使用 GM_setValue 安全地儲存到擴充套件的儲存空間。
     *
     * SAS URL 的安全性說明：
     *   儲存於 GM_setValue 的資料位於 Tampermonkey 擴充套件的 IndexedDB/storage 空間，
     *   頁面腳本（網站的 JS）無法讀取，比 localStorage 更安全。
     *   但 SAS URL 本身具有時效性，建議定期更換並設定最短必要期限。
     */
    function configureSasUrl() {
        // 讀取現有 SAS URL 作為預設值，方便使用者確認或修改
        const current = GM_getValue(SAS_URL_STORAGE_KEY, '');

        const input = prompt(
            '請貼入 Azure Blob Container SAS URL：\n\n' +
            '格式範例：\n' +
            'https://<帳號>.blob.core.windows.net/<容器>?sv=...&sp=cw&sig=...\n\n' +
            '※ 需包含 Create（c）與 Write（w）權限\n' +
            '※ 請使用 Container 層級 SAS URL（路徑結尾為容器名稱，後接 ?）\n' +
            '※ 如要清除設定請輸入空白後確定',
            current
        );

        // 使用者點擊「取消」時 prompt() 回傳 null，不做任何動作
        if (input === null) return;

        const trimmed = input.trim();

        if (!trimmed) {
            // 使用者清空輸入 → 清除設定
            GM_setValue(SAS_URL_STORAGE_KEY, '');
            alert('Azure Blob SAS URL 已清除。');
            return;
        }

        // 進行基本格式驗證：必須是有效的 HTTPS URL 且 hostname 包含 blob.core.windows.net
        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'https:') {
                throw new Error('SAS URL 必須使用 HTTPS 協定。');
            }
            if (!parsed.hostname.endsWith('.blob.core.windows.net')) {
                throw new Error('SAS URL 的 hostname 必須以 .blob.core.windows.net 結尾。');
            }
            if (!parsed.search || !parsed.search.includes('sig=')) {
                throw new Error('SAS URL 似乎缺少 sig 參數，請確認複製的是完整的 SAS URL。');
            }
        } catch (err) {
            alert(`SAS URL 驗證失敗：\n${err.message}\n\n請重新設定。`);
            return;
        }

        // 驗證通過，使用 GM_setValue 安全儲存
        GM_setValue(SAS_URL_STORAGE_KEY, trimmed);
        alert('✅ Azure Blob SAS URL 已儲存成功！\n現在可以使用「📸 儲存網頁快照」功能了。');
    }

    /**
     * 註冊「context-menu 觸發橋接器」。
     *
     * 設計意圖：
     *   - 讓本腳本維持 document-idle 常駐能力（可保留既有選單與狀態提示邏輯）。
     *   - 同時提供另一個 @run-at context-menu 的輕量腳本作為觸發入口。
     *   - 主邏輯只保留一份在本檔案，避免雙份實作造成版本漂移與維護成本上升。
     */
    function registerContextMenuBridge() {
        document.addEventListener(CONTEXT_MENU_TRIGGER_EVENT, (event) => {
            const detail = event?.detail || {};

            // 僅接受本功能對應的事件，避免未來擴充時彼此誤觸。
            if (detail.feature !== 'save-page-to-azure-blob') {
                return;
            }

            // 先回 ACK，讓觸發端可快速得知主腳本已接手。
            document.dispatchEvent(new CustomEvent(CONTEXT_MENU_ACK_EVENT, {
                detail: {
                    handledBy: 'SavePageToAzureBlob.user.js',
                    timestamp: Date.now()
                }
            }));

            // 實際執行快照儲存流程。
            void savePageToAzureBlob();
        });
    }

    // ===== 向 Tampermonkey 選單註冊兩個指令 =====

    // 先設定 SAS URL（依賴此設定才能上傳），故放在第一個位置讓使用者容易找到
    GM_registerMenuCommand('⚙️ 設定 Azure Blob SAS URL', configureSasUrl);

    // 主要功能：擷取快照並上傳
    GM_registerMenuCommand('📸 儲存網頁快照', savePageToAzureBlob);

    // 支援由 Tampermonkey context-menu 腳本直接觸發同一套主流程。
    registerContextMenuBridge();

})();
