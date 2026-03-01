// ==UserScript==
// @name         表單快照與人類模擬回填
// @version      0.1.0
// @description  透過選單命令儲存目前頁面表單快照，可人類化回填，並支援匯出/匯入全部快照資料以跨電腦移轉
// @license      MIT
// @homepage     https://blog.miniasp.com/
// @homepageURL  https://blog.miniasp.com/
// @website      https://www.facebook.com/will.fans
// @source       https://github.com/doggy8088/TampermonkeyUserscripts/raw/main/src/FormSnapshotHumanLikeRefill.user.js
// @namespace    https://github.com/doggy8088/TampermonkeyUserscripts/raw/main/src/FormSnapshotHumanLikeRefill.user.js
// @author       Will Huang
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// ==/UserScript==

(function () {
    'use strict';

    /**
     * 設計目標（高層摘要）：
        * 1. 提供多個選單命令（快照、回填、匯出、匯入）：
        *    - 快照目前頁面的表單欄位（依「完整 URL」分桶）
        *    - 回填該 URL 先前的快照
        *    - 匯出/匯入全部快照資料（跨電腦移轉）
    * 2. 回填時盡量模擬真人互動：focus、鍵盤、beforeinput、input、change、blur、滑鼠事件。
    * 3. 回填過程支援 Esc 中止，並逐欄高亮閃爍，全部完成後顯示可手動關閉且 3 秒自動消失的 toast。
     *
     * 重要限制（刻意設計）：
     * - 這一版只保留「單一版本快照」，同一網址再次快照會覆蓋舊資料。
     * - key 以 location.href 作為分桶依據，確保「依目前網址區分」的要求。
     */

    const SCRIPT_SCOPE = 'FormSnapshotHumanLikeRefill';
    const SNAPSHOT_SCHEMA_VERSION = 1;
    const EXPORT_SCHEMA_VERSION = 1;
    const EXPORT_PAYLOAD_TYPE = `${SCRIPT_SCOPE}:all-settings`;
    const SCRIPT_STORAGE_KEY_PREFIX = `${SCRIPT_SCOPE}:`;
    const STORAGE_KEY_PREFIX = `${SCRIPT_SCOPE}:snapshot`;
    const SNAPSHOT_STORAGE_KEY_PREFIX = `${STORAGE_KEY_PREFIX}:`;
    const SNAPSHOT_INDEX_STORAGE_KEY = `${SCRIPT_SCOPE}:snapshot-index`;

    const STYLE_ID = 'tm-form-snapshot-style';
    const HIGHLIGHT_CLASS = 'tm-form-snapshot-highlight';
    const TOAST_ID = 'tm-form-snapshot-toast';

    const FORM_FIELD_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
    const INPUT_TYPES_TO_SKIP = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'file']);
    const TEXT_LIKE_INPUT_TYPES = new Set([
        'text', 'search', 'url', 'tel', 'email', 'password',
        'number', 'date', 'datetime-local', 'month', 'time', 'week'
    ]);

    const FIELD_TYPING_DELAY = { min: 18, max: 56 };
    const FIELD_GAP_DELAY = { min: 45, max: 120 };
    const FIELD_GAP_DELAY_FAST = { min: 8, max: 28 };
    const FIELD_FINALIZE_DELAY = { min: 70, max: 120 };
    const FIELD_FINALIZE_DELAY_FAST = { min: 16, max: 40 };
    const APPLY_ABORT_ERROR_NAME = 'FormSnapshotApplyAbortedError';
    const APPLY_ABORT_ERROR_MESSAGE = '[FormSnapshot] 回填已由使用者中止';
    const APPLY_ABORT_KEY = 'Escape';

    let isApplyingSnapshot = false;
    let applyAbortRequested = false;
    let detachApplyAbortListener = null;

    injectStyles();
    registerMenuCommands();

    function registerMenuCommands() {
        // 意圖：在不支援 userscript API 的環境安全退場，避免 throw 影響頁面。
        if (typeof GM_registerMenuCommand !== 'function') {
            console.warn('[FormSnapshot] GM_registerMenuCommand 不可用，已略過選單註冊。');
            return;
        }

        GM_registerMenuCommand('📸 將目前表單欄位進行快照（依網址）', handleCreateSnapshot);
        GM_registerMenuCommand('🧩 將先前快照表單欄位回填（模擬輸入）', () => {
            void handleApplySnapshot();
        });
        GM_registerMenuCommand('📤 匯出所有網站快照設定（JSON）', () => {
            void handleExportAllSettings();
        });
        GM_registerMenuCommand('📥 匯入所有網站快照設定（JSON）', () => {
            void handleImportAllSettings();
        });
    }

    function handleCreateSnapshot() {
        const fields = getFormFields();

        if (fields.length === 0) {
            showToast('⚠️ 目前頁面找不到可快照的表單欄位。', { duration: 3000, closable: true });
            return;
        }

        const snapshot = {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            createdAt: new Date().toISOString(),
            url: location.href,
            fields: fields
                .map((field, globalIndex) => createFieldSnapshot(field, globalIndex))
                .filter(Boolean),
        };

        const saveOk = saveSnapshotForCurrentUrl(snapshot);
        if (!saveOk) {
            showToast('❌ 快照儲存失敗，請檢查 Console 訊息。', { duration: 3500, closable: true });
            return;
        }

        showToast(`✅ 已儲存 ${snapshot.fields.length} 個欄位快照（僅此網址）。`, {
            duration: 3000,
            closable: true,
        });
    }

    async function handleApplySnapshot() {
        if (isApplyingSnapshot) {
            showToast('⏳ 目前正在回填中，請稍候。', { duration: 2200, closable: true });
            return;
        }

        const snapshot = loadSnapshotForCurrentUrl();
        if (!snapshot || !Array.isArray(snapshot.fields) || snapshot.fields.length === 0) {
            showToast('⚠️ 找不到此網址的快照，請先執行「快照」命令。', { duration: 3200, closable: true });
            return;
        }

        isApplyingSnapshot = true;
        beginApplyAbortMonitoring();

        const stats = {
            total: snapshot.fields.length,
            applied: 0,
            skipped: 0,
            ignoredErrors: 0,
        };

        try {
            for (const [fieldIndex, fieldSnapshot] of snapshot.fields.entries()) {
                throwIfApplyAbortRequested();

                try {
                    if (!fieldSnapshot || typeof fieldSnapshot !== 'object') {
                        stats.skipped++;
                        continue;
                    }

                    // 相容舊版快照：過去可能會把「未選取 radio」也存進來，
                    // 這些資料不需要動作，直接略過可明顯縮短大量選項頁面的回填時間。
                    if (fieldSnapshot.kind === 'radio' && !fieldSnapshot.checked) {
                        continue;
                    }

                    const element = findElementByLocator(fieldSnapshot.locator);
                    if (!element || !canFillElement(element)) {
                        stats.skipped++;
                        continue;
                    }

                    // 如果欄位目前值已經和快照一致，不需要再模擬事件，
                    // 可以省下 focus/click/keydown 與 delay 成本。
                    if (isFieldAlreadyMatchingSnapshot(element, fieldSnapshot)) {
                        continue;
                    }

                    const applied = await applyFieldSnapshot(element, fieldSnapshot);
                    if (applied) {
                        stats.applied++;
                        const gapDelay = getGapDelayRangeByFieldKind(fieldSnapshot.kind);
                        await sleep(randomInt(gapDelay.min, gapDelay.max));
                        throwIfApplyAbortRequested();
                    } else {
                        stats.skipped++;
                    }
                } catch (error) {
                    if (isApplyAbortError(error)) {
                        throw error;
                    }

                    // 容錯目標：單一欄位找不到或回填失敗時，不中斷整批流程。
                    stats.skipped++;
                    stats.ignoredErrors++;
                    console.warn(`[FormSnapshot] 第 ${fieldIndex + 1} 欄回填失敗，已自動略過。`, error, fieldSnapshot);
                }
            }

            // 依需求：全部完成時顯示 3 秒 toast，且可手動關閉。
            const ignoredErrorHint = stats.ignoredErrors > 0
                ? `（容錯略過 ${stats.ignoredErrors} 次錯誤）`
                : '';
            showToast(`🎉 回填完成：成功 ${stats.applied} 欄，略過 ${stats.skipped} 欄${ignoredErrorHint}。`, {
                duration: 3000,
                closable: true,
            });
        } catch (error) {
            if (isApplyAbortError(error)) {
                showToast('⏹️ 已停止回填（Esc）。', { duration: 2200, closable: true });
            } else {
                console.error('[FormSnapshot] 回填過程發生錯誤：', error);
                showToast('❌ 回填過程發生錯誤，請查看 Console。', { duration: 3500, closable: true });
            }
        } finally {
            endApplyAbortMonitoring();
            isApplyingSnapshot = false;
        }
    }

    function beginApplyAbortMonitoring() {
        applyAbortRequested = false;

        if (typeof detachApplyAbortListener === 'function') {
            detachApplyAbortListener();
        }

        const onKeyDown = (event) => {
            if (!isApplyingSnapshot) return;
            if (event.key !== APPLY_ABORT_KEY) return;
            if (applyAbortRequested) return;

            applyAbortRequested = true;
            showToast('⏹️ 偵測到 Esc，正在停止回填...', { duration: 1200, closable: true });
        };

        window.addEventListener('keydown', onKeyDown, true);
        detachApplyAbortListener = () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }

    function endApplyAbortMonitoring() {
        if (typeof detachApplyAbortListener === 'function') {
            detachApplyAbortListener();
        }

        detachApplyAbortListener = null;
        applyAbortRequested = false;
    }

    function createApplyAbortError() {
        const error = new Error(APPLY_ABORT_ERROR_MESSAGE);
        error.name = APPLY_ABORT_ERROR_NAME;
        return error;
    }

    function throwIfApplyAbortRequested() {
        if (applyAbortRequested) {
            throw createApplyAbortError();
        }
    }

    function isApplyAbortError(error) {
        return !!error && error.name === APPLY_ABORT_ERROR_NAME;
    }

    async function handleExportAllSettings() {
        const payload = buildAllSettingsExportPayload();
        if (!payload) {
            showToast('⚠️ 目前沒有可匯出的快照資料。', { duration: 3000, closable: true });
            return;
        }

        const jsonText = JSON.stringify(payload, null, 2);
        const fileName = `${SCRIPT_SCOPE}-settings-${formatExportTimestamp(new Date())}.json`;

        const downloaded = downloadTextFile(fileName, jsonText);
        const copied = await tryWriteTextToClipboard(jsonText);

        if (downloaded && copied) {
            showToast(`✅ 已匯出 ${payload.totalEntries} 筆設定，並下載檔案與複製到剪貼簿。`, {
                duration: 3200,
                closable: true,
            });
            return;
        }

        if (downloaded) {
            showToast(`✅ 已匯出 ${payload.totalEntries} 筆設定並下載 JSON 檔案。`, {
                duration: 3200,
                closable: true,
            });
            return;
        }

        if (copied) {
            showToast(`✅ 已匯出 ${payload.totalEntries} 筆設定並複製到剪貼簿。`, {
                duration: 3200,
                closable: true,
            });
            return;
        }

        // 兩者都失敗時，仍提供手動備援，避免功能完全不可用。
        prompt('無法自動下載/複製，請手動複製以下 JSON：', jsonText);
        showToast('⚠️ 已提供手動複製視窗，請自行保存 JSON。', { duration: 3200, closable: true });
    }

    async function handleImportAllSettings() {
        const useFilePicker = confirm('按「確定」選擇 JSON 檔匯入；按「取消」改為直接貼上 JSON 文字。');

        let jsonText = '';
        if (useFilePicker) {
            try {
                jsonText = await pickJsonFileText();
            } catch (error) {
                console.error('[FormSnapshot] 讀取匯入檔案失敗：', error);
                showToast('❌ 讀取匯入檔案失敗，請查看 Console。', { duration: 3500, closable: true });
                return;
            }

            if (!jsonText) {
                showToast('ℹ️ 已取消匯入。', { duration: 1800, closable: true });
                return;
            }
        } else {
            const pasted = prompt('請貼上匯出 JSON 內容：', '');
            if (!pasted || !pasted.trim()) {
                showToast('ℹ️ 已取消匯入。', { duration: 1800, closable: true });
                return;
            }

            jsonText = pasted;
        }

        let payload;
        try {
            payload = JSON.parse(jsonText);
        } catch (error) {
            showToast('❌ 匯入內容不是有效的 JSON 格式。', { duration: 3200, closable: true });
            return;
        }

        const entries = extractImportEntries(payload);
        if (entries.length === 0) {
            showToast('⚠️ 找不到可匯入的快照設定內容。', { duration: 3200, closable: true });
            return;
        }

        if (!confirm(`即將匯入 ${entries.length} 筆設定，既有同鍵資料會被覆蓋，是否繼續？`)) {
            showToast('ℹ️ 已取消匯入。', { duration: 1800, closable: true });
            return;
        }

        let successCount = 0;
        let failedCount = 0;

        for (const entry of entries) {
            const ok = saveStorageValueByKey(entry.key, entry.value, { silent: true });
            if (ok) {
                successCount++;
            } else {
                failedCount++;
            }
        }

        // 匯入後重建索引，確保舊版資料或手動編輯 JSON 後仍能被完整列舉與匯出。
        refreshSnapshotIndexFromStorage();

        showToast(`✅ 匯入完成：成功 ${successCount} 筆，失敗 ${failedCount} 筆。`, {
            duration: 3500,
            closable: true,
        });
    }

    function createFieldSnapshot(element, globalIndex) {
        const kind = getFieldKind(element);
        if (!kind) return null;

        const locator = buildLocator(element, globalIndex);
        const base = {
            kind,
            locator,
            tagName: element.tagName.toLowerCase(),
        };

        if (element instanceof HTMLInputElement) {
            const inputType = (element.type || 'text').toLowerCase();
            base.inputType = inputType;

            // 效能優化：radio 只保留「被選取」的那一顆。
            // 未選取項目在回填時不會產生有效動作，保留只會拖慢流程。
            if (inputType === 'radio') {
                if (!element.checked) return null;
                base.checked = true;
                base.value = element.value || '';
                return base;
            }

            if (inputType === 'checkbox') {
                base.checked = !!element.checked;
                base.value = element.value || '';
                return base;
            }

            base.value = element.value ?? '';
            return base;
        }

        if (element instanceof HTMLTextAreaElement) {
            base.value = element.value ?? '';
            return base;
        }

        if (element instanceof HTMLSelectElement) {
            if (element.multiple) {
                base.selectedValues = Array.from(element.selectedOptions).map(option => option.value);
            } else {
                base.value = element.value ?? '';
            }
            return base;
        }

        // contenteditable
        base.value = element.textContent ?? '';
        return base;
    }

    function buildLocator(element, globalIndex) {
        const tagName = element.tagName.toLowerCase();
        const name = element.getAttribute('name') || '';

        return {
            id: element.id || '',
            name,
            tagName,
            globalIndex,
            sameNameIndex: name ? getSameNameIndex(element, tagName, name) : -1,
            cssPath: buildCssPath(element),
            placeholder: element.getAttribute('placeholder') || '',
            ariaLabel: element.getAttribute('aria-label') || '',
        };
    }

    function getSameNameIndex(target, tagName, name) {
        const sameNameElements = queryElementsByTagName(tagName)
            .filter(node => node.getAttribute('name') === name);
        return sameNameElements.indexOf(target);
    }

    function normalizeLocator(locator) {
        if (!locator || typeof locator !== 'object') return null;

        return {
            id: normalizeLocatorString(locator.id, 512),
            name: normalizeLocatorString(locator.name, 512),
            tagName: normalizeTagName(locator.tagName),
            globalIndex: normalizeNonNegativeInteger(locator.globalIndex, -1),
            sameNameIndex: normalizeNonNegativeInteger(locator.sameNameIndex, -1),
            cssPath: normalizeLocatorString(locator.cssPath, 4096),
        };
    }

    function normalizeLocatorString(value, maxLength = 1024) {
        if (typeof value !== 'string') return '';

        const trimmed = value.trim();
        if (!trimmed) return '';

        return trimmed.slice(0, maxLength);
    }

    function normalizeTagName(tagName) {
        const normalized = normalizeLocatorString(tagName, 64).toLowerCase();
        if (!normalized) return '';

        // 只接受 HTML tag 命名可接受字元，避免 query API 因非法 selector 拋錯。
        if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
            return '';
        }

        return normalized;
    }

    function normalizeNonNegativeInteger(value, fallback = -1) {
        const numeric = Number(value);
        if (!Number.isInteger(numeric) || numeric < 0) {
            return fallback;
        }

        return numeric;
    }

    function queryElementsByTagName(tagName) {
        const normalizedTagName = normalizeTagName(tagName);
        if (!normalizedTagName) return [];

        try {
            return Array.from(document.getElementsByTagName(normalizedTagName))
                .filter(node => node instanceof HTMLElement);
        } catch (error) {
            return [];
        }
    }

    function findElementByLocator(locator) {
        const normalizedLocator = normalizeLocator(locator);
        if (!normalizedLocator) return null;

        // 1) 優先用 id（通常最穩定）。
        if (normalizedLocator.id) {
            const byId = document.getElementById(normalizedLocator.id);
            if (isLocatorMatchedElement(byId, normalizedLocator)) return byId;
        }

        // 2) 再用同 tag + name + index。
        if (normalizedLocator.name && normalizedLocator.tagName) {
            const byName = queryElementsByTagName(normalizedLocator.tagName)
                .filter(node => node.getAttribute('name') === normalizedLocator.name);

            if (normalizedLocator.sameNameIndex >= 0 && normalizedLocator.sameNameIndex < byName.length) {
                const exact = byName[normalizedLocator.sameNameIndex];
                if (isLocatorMatchedElement(exact, normalizedLocator)) return exact;
            }

            if (byName.length > 0) {
                const first = byName[0];
                if (isLocatorMatchedElement(first, normalizedLocator, true)) return first;
            }
        }

        // 3) 再嘗試 cssPath。
        if (normalizedLocator.cssPath) {
            try {
                const byPath = document.querySelector(normalizedLocator.cssPath);
                if (isLocatorMatchedElement(byPath, normalizedLocator, true)) return byPath;
            } catch (error) {
                // cssPath 可能因 DOM 變動而失效，這裡刻意吞掉，改走後續 fallback。
            }
        }

        // 4) 最後 fallback：用快照時的全域索引。
        const fields = getFormFields();
        if (normalizedLocator.globalIndex >= 0 && normalizedLocator.globalIndex < fields.length) {
            return fields[normalizedLocator.globalIndex];
        }

        return null;
    }

    function isLocatorMatchedElement(element, locator, loose = false) {
        if (!(element instanceof HTMLElement)) return false;

        const tagMatches = !locator.tagName || element.tagName.toLowerCase() === locator.tagName;
        if (!tagMatches) return false;

        if (!loose && locator.id && element.id && locator.id !== element.id) return false;
        if (!loose && locator.name) {
            const name = element.getAttribute('name') || '';
            if (name !== locator.name) return false;
        }

        return true;
    }

    function getFormFields() {
        const all = Array.from(document.querySelectorAll(FORM_FIELD_SELECTOR));
        return all.filter(isSupportedField);
    }

    function isSupportedField(element) {
        if (!(element instanceof HTMLElement)) return false;

        // 避免腳本自己的 UI 被掃進快照。
        if (element.id === TOAST_ID || element.closest(`#${TOAST_ID}`)) return false;

        if (element instanceof HTMLInputElement) {
            const type = (element.type || 'text').toLowerCase();
            if (INPUT_TYPES_TO_SKIP.has(type)) return false;
        }

        // contenteditable 僅處理最外層，避免父子節點重複快照。
        if (element.isContentEditable) {
            const parentEditable = element.parentElement?.closest('[contenteditable]:not([contenteditable="false"])');
            if (parentEditable && parentEditable !== element) return false;
        }

        return true;
    }

    function canFillElement(element) {
        if (!isSupportedField(element)) return false;
        if (!element.isConnected) return false;

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            if (element.disabled) return false;
        }

        // 文字欄位若 readonly，視為不可安全回填（避免觸發不預期錯誤）。
        if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) {
            const type = element instanceof HTMLInputElement ? (element.type || 'text').toLowerCase() : 'textarea';
            if (type !== 'checkbox' && type !== 'radio') {
                return false;
            }
        }

        return true;
    }

    function getFieldKind(element) {
        if (element instanceof HTMLInputElement) {
            const type = (element.type || 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            return 'input';
        }

        if (element instanceof HTMLTextAreaElement) return 'textarea';
        if (element instanceof HTMLSelectElement) return element.multiple ? 'select-multiple' : 'select-one';
        if (element.isContentEditable) return 'contenteditable';

        return null;
    }

    async function applyFieldSnapshot(element, fieldSnapshot) {
        if (!(element instanceof HTMLElement) || !element.isConnected) {
            return false;
        }

        const stopHighlight = highlightElement(element);

        try {
            throwIfApplyAbortRequested();
            safeScrollIntoView(element);
            await sleep(randomInt(60, 130));
            throwIfApplyAbortRequested();

            // SPA 或動態表單在等待期間可能重繪欄位，若元素已脫離 DOM 就直接略過。
            if (!element.isConnected) {
                return false;
            }

            switch (fieldSnapshot.kind) {
                case 'checkbox':
                    return await applyCheckboxValue(element, !!fieldSnapshot.checked);

                case 'radio':
                    // radio 的 false 狀態無法用「使用者點擊」直接設定，
                    // 只對 true 的項目執行選取，維持接近真實互動的行為。
                    if (!fieldSnapshot.checked) return true;
                    return await applyRadioValue(element, true);

                case 'select-one':
                case 'select-multiple':
                    return await applySelectValue(element, fieldSnapshot);

                case 'contenteditable':
                    return await applyContentEditableValue(element, String(fieldSnapshot.value ?? ''));

                case 'textarea':
                case 'input':
                default:
                    return await applyTextLikeValue(element, String(fieldSnapshot.value ?? ''));
            }
        } finally {
            const finalizeDelay = getFinalizeDelayRangeByFieldKind(fieldSnapshot.kind);
            await sleep(randomInt(finalizeDelay.min, finalizeDelay.max));
            stopHighlight();
        }
    }

    async function applyTextLikeValue(element, targetValue) {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || !element.isConnected) {
            return false;
        }

        throwIfApplyAbortRequested();

        const inputType = element instanceof HTMLInputElement ? (element.type || 'text').toLowerCase() : 'textarea';
        const shouldTypeCharByChar = element instanceof HTMLTextAreaElement || TEXT_LIKE_INPUT_TYPES.has(inputType);

        simulatePointerHoverSequence(element);
        simulatePointerClickSequence(element, { invokeNativeClick: false });
        safeFocusElement(element);
        dispatchSimpleEvent(element, 'focusin');

        if (shouldTypeCharByChar) {
            await clearTextLikeValue(element);
            throwIfApplyAbortRequested();

            for (const char of targetValue) {
                throwIfApplyAbortRequested();
                dispatchKeyboardEvent(element, 'keydown', char);
                dispatchKeyboardEvent(element, 'keypress', char);
                dispatchBeforeInputEvent(element, char, 'insertText');

                const nextValue = `${getTextLikeValue(element)}${char}`;
                setTextLikeValue(element, nextValue);

                dispatchInputEvent(element, char, 'insertText');
                dispatchKeyboardEvent(element, 'keyup', char);

                await sleep(randomInt(FIELD_TYPING_DELAY.min, FIELD_TYPING_DELAY.max));
                throwIfApplyAbortRequested();
            }
        } else {
            // 例如 color、range 等欄位，直接設定值並補齊 input/change 事件。
            setTextLikeValue(element, targetValue);
            dispatchInputEvent(element, null, 'insertReplacementText');
        }

        dispatchSimpleEvent(element, 'change');
        dispatchSimpleEvent(element, 'blur');
        safeBlurElement(element);

        return true;
    }

    async function clearTextLikeValue(element) {
        if (!element.isConnected) return;

        throwIfApplyAbortRequested();
        const current = getTextLikeValue(element);
        if (!current) return;

        // 盡量模擬「Ctrl+A + Delete」的語意事件，再做實際清空。
        dispatchKeyboardEvent(element, 'keydown', 'a', { ctrlKey: true });
        dispatchKeyboardEvent(element, 'keyup', 'a', { ctrlKey: true });
        dispatchKeyboardEvent(element, 'keydown', 'Delete');
        dispatchBeforeInputEvent(element, null, 'deleteContentBackward');

        setTextLikeValue(element, '');
        dispatchInputEvent(element, null, 'deleteContentBackward');
        dispatchKeyboardEvent(element, 'keyup', 'Delete');

        await sleep(randomInt(30, 70));
        throwIfApplyAbortRequested();
    }

    async function applyContentEditableValue(element, targetValue) {
        if (!(element instanceof HTMLElement) || !element.isContentEditable || !element.isConnected) return false;

        throwIfApplyAbortRequested();

        simulatePointerHoverSequence(element);
        simulatePointerClickSequence(element, { invokeNativeClick: false });
        safeFocusElement(element);
        dispatchSimpleEvent(element, 'focusin');

        const current = element.textContent ?? '';
        if (current.length > 0) {
            dispatchKeyboardEvent(element, 'keydown', 'Delete');
            dispatchBeforeInputEvent(element, null, 'deleteContentBackward');
            element.textContent = '';
            dispatchInputEvent(element, null, 'deleteContentBackward');
            dispatchKeyboardEvent(element, 'keyup', 'Delete');
            await sleep(randomInt(30, 70));
            throwIfApplyAbortRequested();
        }

        for (const char of targetValue) {
            throwIfApplyAbortRequested();
            dispatchKeyboardEvent(element, 'keydown', char);
            dispatchKeyboardEvent(element, 'keypress', char);
            dispatchBeforeInputEvent(element, char, 'insertText');

            element.textContent = `${element.textContent ?? ''}${char}`;

            dispatchInputEvent(element, char, 'insertText');
            dispatchKeyboardEvent(element, 'keyup', char);

            await sleep(randomInt(FIELD_TYPING_DELAY.min, FIELD_TYPING_DELAY.max));
            throwIfApplyAbortRequested();
        }

        dispatchSimpleEvent(element, 'change');
        dispatchSimpleEvent(element, 'blur');
        safeBlurElement(element);
        return true;
    }

    async function applyCheckboxValue(element, targetChecked) {
        if (!(element instanceof HTMLInputElement) || element.type.toLowerCase() !== 'checkbox' || !element.isConnected) return false;

        throwIfApplyAbortRequested();

        simulatePointerHoverSequence(element);
        safeFocusElement(element);
        dispatchSimpleEvent(element, 'focusin');

        if (element.checked !== targetChecked) {
            simulatePointerClickSequence(element);

            // 若頁面攔截 click 導致狀態沒變，fallback 為原生 checked setter。
            if (element.checked !== targetChecked) {
                setNativeChecked(element, targetChecked);
                dispatchInputEvent(element, null, 'insertReplacementText');
                dispatchSimpleEvent(element, 'change');
            }
        }

        dispatchSimpleEvent(element, 'blur');
        safeBlurElement(element);
        await sleep(randomInt(30, 70));
        throwIfApplyAbortRequested();
        return true;
    }

    async function applyRadioValue(element, targetChecked) {
        if (!(element instanceof HTMLInputElement) || element.type.toLowerCase() !== 'radio' || !element.isConnected) return false;
        if (!targetChecked) return true;

        throwIfApplyAbortRequested();

        simulatePointerHoverSequence(element);
        safeFocusElement(element);
        dispatchSimpleEvent(element, 'focusin');

        if (!element.checked) {
            simulatePointerClickSequence(element);

            if (!element.checked) {
                setNativeChecked(element, true);
                dispatchInputEvent(element, null, 'insertReplacementText');
                dispatchSimpleEvent(element, 'change');
            }
        }

        dispatchSimpleEvent(element, 'blur');
        safeBlurElement(element);
        await sleep(randomInt(30, 70));
        throwIfApplyAbortRequested();
        return true;
    }

    async function applySelectValue(element, fieldSnapshot) {
        if (!(element instanceof HTMLSelectElement) || !element.isConnected) return false;

        throwIfApplyAbortRequested();

        // select 若已經是目標值，直接略過互動與事件派發。
        if (isFieldAlreadyMatchingSnapshot(element, fieldSnapshot)) {
            return true;
        }

        simulatePointerHoverSequence(element);
        simulatePointerClickSequence(element, { invokeNativeClick: false });
        safeFocusElement(element);
        dispatchSimpleEvent(element, 'focusin');

        if (fieldSnapshot.kind === 'select-multiple') {
            const selected = new Set(Array.isArray(fieldSnapshot.selectedValues) ? fieldSnapshot.selectedValues : []);
            Array.from(element.options).forEach(option => {
                option.selected = selected.has(option.value);
            });
        } else {
            const targetValue = String(fieldSnapshot.value ?? '');
            setNativeSelectValue(element, targetValue);
        }

        dispatchInputEvent(element, null, 'insertReplacementText');
        dispatchSimpleEvent(element, 'change');
        dispatchSimpleEvent(element, 'blur');
        safeBlurElement(element);

        await sleep(randomInt(30, 70));
        throwIfApplyAbortRequested();
        return true;
    }

    function safeFocusElement(element) {
        if (!(element instanceof HTMLElement) || !element.isConnected) return false;

        try {
            element.focus({ preventScroll: true });
            return true;
        } catch (error) {
            // 某些客製元件會覆寫 focus 造成參數不相容，退回最基本呼叫。
            try {
                element.focus();
                return true;
            } catch (ignored) {
                return false;
            }
        }
    }

    function safeBlurElement(element) {
        if (!(element instanceof HTMLElement)) return false;

        try {
            element.blur();
            return true;
        } catch (error) {
            return false;
        }
    }

    function isTextLikeFieldKind(kind) {
        return kind === 'input' || kind === 'textarea' || kind === 'contenteditable';
    }

    function getGapDelayRangeByFieldKind(kind) {
        return isTextLikeFieldKind(kind) ? FIELD_GAP_DELAY : FIELD_GAP_DELAY_FAST;
    }

    function getFinalizeDelayRangeByFieldKind(kind) {
        return isTextLikeFieldKind(kind) ? FIELD_FINALIZE_DELAY : FIELD_FINALIZE_DELAY_FAST;
    }

    function isFieldAlreadyMatchingSnapshot(element, fieldSnapshot) {
        if (!fieldSnapshot || typeof fieldSnapshot !== 'object') return false;

        switch (fieldSnapshot.kind) {
            case 'checkbox':
            case 'radio': {
                if (!(element instanceof HTMLInputElement)) return false;
                return element.checked === !!fieldSnapshot.checked;
            }

            case 'select-one': {
                if (!(element instanceof HTMLSelectElement)) return false;
                return element.value === String(fieldSnapshot.value ?? '');
            }

            case 'select-multiple': {
                if (!(element instanceof HTMLSelectElement)) return false;

                const targetValues = new Set(
                    (Array.isArray(fieldSnapshot.selectedValues) ? fieldSnapshot.selectedValues : [])
                        .map(value => String(value))
                );
                const currentValues = new Set(
                    Array.from(element.selectedOptions).map(option => option.value)
                );

                if (targetValues.size !== currentValues.size) return false;
                for (const value of targetValues) {
                    if (!currentValues.has(value)) return false;
                }
                return true;
            }

            case 'contenteditable': {
                if (!(element instanceof HTMLElement) || !element.isContentEditable) return false;
                return (element.textContent ?? '') === String(fieldSnapshot.value ?? '');
            }

            case 'textarea':
            case 'input':
            default: {
                if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
                return element.value === String(fieldSnapshot.value ?? '');
            }
        }
    }

    function setTextLikeValue(element, value) {
        if (element instanceof HTMLInputElement) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (descriptor && typeof descriptor.set === 'function') {
                descriptor.set.call(element, value);
                return;
            }
        }

        if (element instanceof HTMLTextAreaElement) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (descriptor && typeof descriptor.set === 'function') {
                descriptor.set.call(element, value);
                return;
            }
        }

        // fallback
        element.value = value;
    }

    function getTextLikeValue(element) {
        return element.value ?? '';
    }

    function setNativeChecked(element, checked) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
        if (descriptor && typeof descriptor.set === 'function') {
            descriptor.set.call(element, checked);
        } else {
            element.checked = checked;
        }
    }

    function setNativeSelectValue(element, value) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (descriptor && typeof descriptor.set === 'function') {
            descriptor.set.call(element, value);
        } else {
            element.value = value;
        }
    }

    function simulatePointerHoverSequence(target) {
        dispatchPointerEvent(target, 'pointerover');
        dispatchPointerEvent(target, 'pointerenter');
        dispatchMouseEvent(target, 'mouseover');
        dispatchMouseEvent(target, 'mouseenter');
    }

    function simulatePointerClickSequence(target, { invokeNativeClick = true } = {}) {
        dispatchPointerEvent(target, 'pointerdown');
        dispatchMouseEvent(target, 'mousedown');
        dispatchPointerEvent(target, 'pointerup');
        dispatchMouseEvent(target, 'mouseup');

        // click() 會觸發目標元素的原生 click 流程，通常可帶動框架層監聽器。
        if (invokeNativeClick && typeof target.click === 'function') {
            target.click();
        } else {
            dispatchMouseEvent(target, 'click');
        }
    }

    function dispatchPointerEvent(target, type) {
        try {
            const event = new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
            });
            target.dispatchEvent(event);
        } catch (error) {
            // 舊環境沒有 PointerEvent 時退回一般 Event，至少保留事件名稱。
            dispatchSimpleEvent(target, type);
        }
    }

    function dispatchMouseEvent(target, type) {
        try {
            const event = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
            });
            target.dispatchEvent(event);
        } catch (error) {
            dispatchSimpleEvent(target, type);
        }
    }

    function dispatchKeyboardEvent(target, type, key, extra = {}) {
        const keyInfo = inferKeyMeta(key);

        try {
            const event = new KeyboardEvent(type, {
                key: keyInfo.key,
                code: keyInfo.code,
                keyCode: keyInfo.keyCode,
                which: keyInfo.keyCode,
                bubbles: true,
                cancelable: true,
                ...extra,
            });
            target.dispatchEvent(event);
        } catch (error) {
            dispatchSimpleEvent(target, type);
        }
    }

    function dispatchBeforeInputEvent(target, data, inputType) {
        try {
            const event = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                data,
                inputType,
            });
            target.dispatchEvent(event);
        } catch (error) {
            dispatchSimpleEvent(target, 'beforeinput');
        }
    }

    function dispatchInputEvent(target, data, inputType) {
        try {
            const event = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data,
                inputType,
            });
            target.dispatchEvent(event);
        } catch (error) {
            dispatchSimpleEvent(target, 'input');
        }
    }

    function dispatchSimpleEvent(target, type) {
        target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    }

    function inferKeyMeta(key) {
        if (key === 'Delete') {
            return { key: 'Delete', code: 'Delete', keyCode: 46 };
        }

        if (key === 'Enter') {
            return { key: 'Enter', code: 'Enter', keyCode: 13 };
        }

        if (typeof key === 'string' && key.length === 1) {
            const isLetter = /^[a-z]$/i.test(key);
            const keyCode = isLetter ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0);
            return {
                key,
                code: isLetter ? `Key${key.toUpperCase()}` : 'Unidentified',
                keyCode,
            };
        }

        return { key: String(key || ''), code: 'Unidentified', keyCode: 0 };
    }

    function highlightElement(element) {
        element.classList.add(HIGHLIGHT_CLASS);
        return () => {
            element.classList.remove(HIGHLIGHT_CLASS);
        };
    }

    function safeScrollIntoView(element) {
        try {
            element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        } catch (error) {
            // 某些舊瀏覽器不支援 smooth 參數，退回基本模式。
            try {
                element.scrollIntoView(true);
            } catch (ignored) {
                // 完全失敗就忽略，不阻斷回填流程。
            }
        }
    }

    function showToast(message, { duration = 3000, closable = true } = {}) {
        injectStyles();

        const existing = document.getElementById(TOAST_ID);
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = TOAST_ID;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');

        const text = document.createElement('div');
        text.className = 'tm-form-snapshot-toast-text';
        text.textContent = message;
        toast.appendChild(text);

        let timer = null;

        const close = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            toast.classList.remove('show');
            window.setTimeout(() => {
                if (toast.isConnected) toast.remove();
            }, 180);
        };

        if (closable) {
            const closeButton = document.createElement('button');
            closeButton.className = 'tm-form-snapshot-toast-close';
            closeButton.type = 'button';
            closeButton.textContent = '✕';
            closeButton.setAttribute('aria-label', '關閉通知');
            closeButton.addEventListener('click', close);
            toast.appendChild(closeButton);
        }

        document.body.appendChild(toast);
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        timer = window.setTimeout(close, duration);
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${HIGHLIGHT_CLASS} {
                outline: 2px solid #ffb020 !important;
                outline-offset: 1px !important;
                border-radius: 4px !important;
                animation: tmFormSnapshotBlink 0.5s ease-in-out infinite;
                box-shadow: 0 0 0 0 rgba(255, 176, 32, 0.45);
            }

            @keyframes tmFormSnapshotBlink {
                0% {
                    box-shadow: 0 0 0 0 rgba(255, 176, 32, 0.55);
                    filter: brightness(1.03);
                }
                50% {
                    box-shadow: 0 0 0 8px rgba(255, 176, 32, 0);
                    filter: brightness(1.16);
                }
                100% {
                    box-shadow: 0 0 0 0 rgba(255, 176, 32, 0);
                    filter: brightness(1.03);
                }
            }

            #${TOAST_ID} {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 2147483647;
                max-width: min(480px, calc(100vw - 24px));
                padding: 12px 12px 12px 14px;
                border-radius: 10px;
                background: rgba(18, 18, 24, 0.95);
                color: #ffffff;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
                display: flex;
                align-items: flex-start;
                gap: 10px;
                transform: translateY(12px);
                opacity: 0;
                transition: opacity 0.18s ease, transform 0.18s ease;
                font-size: 14px;
                line-height: 1.5;
            }

            #${TOAST_ID}.show {
                opacity: 1;
                transform: translateY(0);
            }

            #${TOAST_ID} .tm-form-snapshot-toast-text {
                flex: 1 1 auto;
                word-break: break-word;
            }

            #${TOAST_ID} .tm-form-snapshot-toast-close {
                border: 0;
                background: rgba(255, 255, 255, 0.16);
                color: #ffffff;
                width: 24px;
                height: 24px;
                border-radius: 6px;
                cursor: pointer;
                line-height: 1;
                font-size: 14px;
                flex: 0 0 auto;
            }

            #${TOAST_ID} .tm-form-snapshot-toast-close:hover {
                background: rgba(255, 255, 255, 0.28);
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function getSnapshotStorageKey() {
        return getSnapshotStorageKeyByUrl(location.href);
    }

    function getSnapshotStorageKeyByUrl(url) {
        if (!url || typeof url !== 'string') {
            return `${SNAPSHOT_STORAGE_KEY_PREFIX}${encodeURIComponent(location.href)}`;
        }

        // 依需求：用完整 URL（含 query 與 hash）分桶。
        return `${SNAPSHOT_STORAGE_KEY_PREFIX}${encodeURIComponent(url)}`;
    }

    function saveSnapshotForCurrentUrl(snapshot) {
        const key = getSnapshotStorageKey();

        const saved = saveStorageValueByKey(key, snapshot);
        if (saved) {
            rememberSnapshotStorageKey(key);
        }

        return saved;
    }

    function loadSnapshotForCurrentUrl() {
        const key = getSnapshotStorageKey();

        const raw = loadStorageValueByKey(key, null);
        if (!raw) return null;

        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            } catch (error) {
                console.warn('[FormSnapshot] 快照內容不是有效 JSON，已忽略該筆資料。');
                return null;
            }
        }

        return raw;
    }

    /**
     * 生成完整匯出 payload：
     * - 只匯出本腳本自己的儲存鍵（SCRIPT_SCOPE 前綴）
     * - 包含索引鍵與所有快照鍵，便於在其他電腦完整還原
     */
    function buildAllSettingsExportPayload() {
        refreshSnapshotIndexFromStorage();

        const keys = listScriptStorageKeys();
        if (keys.length === 0) {
            return null;
        }

        const storage = Object.create(null);
        keys.forEach((key) => {
            const value = loadStorageValueByKey(key, undefined, { silent: true });
            if (typeof value !== 'undefined') {
                storage[key] = value;
            }
        });

        const totalEntries = Object.keys(storage).length;
        if (totalEntries === 0) {
            return null;
        }

        return {
            schemaVersion: EXPORT_SCHEMA_VERSION,
            payloadType: EXPORT_PAYLOAD_TYPE,
            exportedAt: new Date().toISOString(),
            source: {
                href: location.href,
                origin: location.origin,
            },
            totalEntries,
            storage,
        };
    }

    function extractImportEntries(payload) {
        if (!payload || typeof payload !== 'object') {
            return [];
        }

        const entries = [];

        // 主要格式：本腳本匯出 payload（payloadType + storage）
        if (payload.storage && typeof payload.storage === 'object' && !Array.isArray(payload.storage)) {
            Object.entries(payload.storage).forEach(([key, value]) => {
                if (!isScriptStorageKey(key)) return;
                entries.push({ key, value });
            });
        }

        // 相容格式：{ snapshots: [{ url, snapshot }] }
        // 允許使用者或舊工具輸出的精簡資料仍可匯入。
        if (Array.isArray(payload.snapshots)) {
            payload.snapshots.forEach((item) => {
                if (!item || typeof item !== 'object') return;

                const url = typeof item.url === 'string'
                    ? item.url
                    : (item.snapshot && typeof item.snapshot.url === 'string' ? item.snapshot.url : '');
                if (!url) return;

                const snapshotValue = item.snapshot && typeof item.snapshot === 'object'
                    ? item.snapshot
                    : item;
                const snapshot = {
                    ...snapshotValue,
                    url,
                };

                if (!Array.isArray(snapshot.fields)) return;

                entries.push({
                    key: getSnapshotStorageKeyByUrl(url),
                    value: snapshot,
                });
            });
        }

        // 去重：若同 key 出現多次，後者覆蓋前者。
        const deduped = new Map();
        entries.forEach((entry) => {
            deduped.set(entry.key, entry.value);
        });

        return Array.from(deduped.entries()).map(([key, value]) => ({ key, value }));
    }

    function listScriptStorageKeys() {
        const keySet = new Set();

        // 1) 後端儲存列舉（優先，最完整）
        listBackendStorageKeys().forEach((key) => {
            if (isScriptStorageKey(key)) {
                keySet.add(key);
            }
        });

        // 2) 索引回補（當環境不支援列舉 API 時，仍可用索引找回快照鍵）
        getSnapshotStorageIndex().forEach((key) => {
            if (isSnapshotStorageKey(key)) {
                keySet.add(key);
            }
        });

        // 3) 索引鍵本身一併納入匯出
        if (keySet.size > 0 || hasStoredValue(SNAPSHOT_INDEX_STORAGE_KEY)) {
            keySet.add(SNAPSHOT_INDEX_STORAGE_KEY);
        }

        return Array.from(keySet);
    }

    function listBackendStorageKeys() {
        // Tampermonkey/Userscript 正規路徑：GM_listValues 可取得腳本所有儲存鍵。
        if (typeof GM_listValues === 'function') {
            try {
                const keys = GM_listValues();
                if (Array.isArray(keys)) {
                    return keys.filter(key => typeof key === 'string');
                }
            } catch (error) {
                console.warn('[FormSnapshot] GM_listValues 失敗，改用 localStorage 掃描。', error);
            }
        }

        // 後備：localStorage（僅在沒有 GM_* 或測試情境下使用）
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (typeof key === 'string') {
                    keys.push(key);
                }
            }
            return keys;
        } catch (error) {
            console.warn('[FormSnapshot] localStorage 掃描失敗。', error);
            return [];
        }
    }

    function isScriptStorageKey(key) {
        return typeof key === 'string' && key.startsWith(SCRIPT_STORAGE_KEY_PREFIX);
    }

    function isSnapshotStorageKey(key) {
        return typeof key === 'string' && key.startsWith(SNAPSHOT_STORAGE_KEY_PREFIX);
    }

    function getSnapshotStorageIndex() {
        const index = loadStorageValueByKey(SNAPSHOT_INDEX_STORAGE_KEY, [], { silent: true });
        if (!Array.isArray(index)) return [];

        return index.filter(isSnapshotStorageKey);
    }

    function rememberSnapshotStorageKey(key) {
        if (!isSnapshotStorageKey(key)) return;

        const current = new Set(getSnapshotStorageIndex());
        if (current.has(key)) return;

        current.add(key);
        saveStorageValueByKey(SNAPSHOT_INDEX_STORAGE_KEY, Array.from(current), { silent: true });
    }

    function refreshSnapshotIndexFromStorage() {
        const merged = new Set(getSnapshotStorageIndex());

        listBackendStorageKeys().forEach((key) => {
            if (isSnapshotStorageKey(key)) {
                merged.add(key);
            }
        });

        saveStorageValueByKey(SNAPSHOT_INDEX_STORAGE_KEY, Array.from(merged), { silent: true });
    }

    function hasStoredValue(key) {
        try {
            if (typeof GM_getValue === 'function') {
                return typeof GM_getValue(key, undefined) !== 'undefined';
            }

            return localStorage.getItem(key) !== null;
        } catch (error) {
            return false;
        }
    }

    function saveStorageValueByKey(key, value, { silent = false } = {}) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
            } else {
                localStorage.setItem(key, JSON.stringify(value));
            }
            return true;
        } catch (error) {
            if (!silent) {
                console.error(`[FormSnapshot] 儲存資料失敗（key: ${key}）：`, error);
            }
            return false;
        }
    }

    function loadStorageValueByKey(key, defaultValue = null, { silent = false } = {}) {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(key, defaultValue);
            }

            const raw = localStorage.getItem(key);
            if (raw === null) return defaultValue;

            try {
                return JSON.parse(raw);
            } catch (error) {
                // localStorage 內若是純字串（非 JSON），仍保留原值回傳。
                return raw;
            }
        } catch (error) {
            if (!silent) {
                console.error(`[FormSnapshot] 讀取資料失敗（key: ${key}）：`, error);
            }
            return defaultValue;
        }
    }

    function formatExportTimestamp(date) {
        const pad = (num) => String(num).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    function downloadTextFile(fileName, content) {
        try {
            const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
            const blobUrl = URL.createObjectURL(blob);

            const anchor = document.createElement('a');
            anchor.href = blobUrl;
            anchor.download = fileName;
            anchor.style.display = 'none';

            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();

            setTimeout(() => {
                URL.revokeObjectURL(blobUrl);
            }, 1000);

            return true;
        } catch (error) {
            console.error('[FormSnapshot] 下載匯出檔失敗：', error);
            return false;
        }
    }

    async function tryWriteTextToClipboard(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (error) {
            console.warn('[FormSnapshot] 複製到剪貼簿失敗：', error);
        }

        return false;
    }

    async function pickJsonFileText() {
        return await new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json,text/json';
            input.style.display = 'none';

            const cleanup = () => {
                if (input.isConnected) {
                    input.remove();
                }
            };

            input.addEventListener('change', async () => {
                try {
                    const file = input.files?.[0];
                    if (!file) {
                        cleanup();
                        resolve('');
                        return;
                    }

                    const text = await file.text();
                    cleanup();
                    resolve(text);
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            }, { once: true });

            document.body.appendChild(input);
            input.click();
        });
    }

    function buildCssPath(element) {
        const segments = [];
        let current = element;

        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
            let segment = current.tagName.toLowerCase();

            if (current.id) {
                segment += `#${safeCssEscape(current.id)}`;
                segments.unshift(segment);
                break;
            }

            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children)
                    .filter(node => node.tagName === current.tagName);
                if (siblings.length > 1) {
                    const nth = siblings.indexOf(current) + 1;
                    segment += `:nth-of-type(${nth})`;
                }
            }

            segments.unshift(segment);
            current = parent;
        }

        return segments.join(' > ');
    }

    function safeCssEscape(value) {
        if (window.CSS && typeof CSS.escape === 'function') {
            return CSS.escape(value);
        }

        return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function sleep(ms) {
        const targetMs = Number(ms) || 0;
        if (targetMs <= 0) {
            return Promise.resolve();
        }

        const SLEEP_SLICE_MS = 20;
        return new Promise((resolve) => {
            let elapsed = 0;

            const tick = () => {
                if (applyAbortRequested || elapsed >= targetMs) {
                    resolve();
                    return;
                }

                const waitMs = Math.min(SLEEP_SLICE_MS, targetMs - elapsed);
                elapsed += waitMs;
                setTimeout(tick, waitMs);
            };

            tick();
        });
    }
})();
