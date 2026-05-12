// ==UserScript==
// @name         B站字幕提取器
// @namespace    https://blog.qitongtingyu.online/
// @version      1.0.0
// @description  从B站视频页面提取字幕文本，支持单个视频/分P视频下载，多种字幕导出格式，提供字幕搜索快速定位功能
// @author       栖桐听雨
// @match        https://www.bilibili.com/video/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        CACHE_MAX_SIZE: 50,
        CACHE_MAX_AGE: 3600000,
        REQUEST_TIMEOUT: 10000,
        REQUEST_RETRIES: 2,
        REQUEST_RETRY_DELAY: 1000,

        STORAGE_KEYS: {
            CUSTOM_EXTENSIONS: 'bili_transcript_custom_extensions',
            DOWNLOAD_SETTINGS: 'bili_transcript_download_settings'
        },

        PRESET_EXTENSIONS: [
            { name: 'TXT', value: 'txt', mimeType: 'text/plain' },
            { name: 'MD', value: 'md', mimeType: 'text/markdown' },
            { name: 'CSV', value: 'csv', mimeType: 'text/csv' },
            { name: 'XML', value: 'xml', mimeType: 'application/xml' },
            { name: 'HTML', value: 'html', mimeType: 'text/html' },
            { name: 'SRT', value: 'srt', mimeType: 'text/x-subrip' },
            { name: 'VTT', value: 'vtt', mimeType: 'text/vtt' },
            { name: 'ASS', value: 'ass', mimeType: 'text/x-ass' },
            { name: 'LRC', value: 'lrc', mimeType: 'text/lrc' },
            { name: 'JSON', value: 'json', mimeType: 'application/json' }
        ],

        DEFAULT_DOWNLOAD_SETTINGS: {
            format: 'txt',
            downloadMethod: 'direct',
            includeBV: true,
            includeTimestamp: false,
            includeDuration: false,
            includeSubtitleTime: true
        }
    };

    const ErrorTypes = {
        NETWORK_ERROR: 'NETWORK_ERROR',
        API_ERROR: 'API_ERROR',
        AUTH_ERROR: 'AUTH_ERROR',
        PARSE_ERROR: 'PARSE_ERROR',
        VALIDATION_ERROR: 'VALIDATION_ERROR',
        UNKNOWN_ERROR: 'UNKNOWN_ERROR'
    };

    class SubtitleError extends Error {
        constructor(type, message, originalError = null) {
            super(message);
            this.type = type;
            this.originalError = originalError;
        }
    }

    // 存储管理模块
    const StorageManager = {
        getCustomExtensions() {
            try {
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.CUSTOM_EXTENSIONS);
                return saved ? JSON.parse(saved) : [];
            } catch (error) {
                console.error('加载自定义扩展名失败:', error);
                return [];
            }
        },

        saveCustomExtensions(extensions) {
            try {
                localStorage.setItem(CONFIG.STORAGE_KEYS.CUSTOM_EXTENSIONS, JSON.stringify(extensions));
            } catch (error) {
                console.error('保存自定义扩展名失败:', error);
            }
        },

        getDownloadSettings() {
            try {
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.DOWNLOAD_SETTINGS);
                return saved ? JSON.parse(saved) : CONFIG.DEFAULT_DOWNLOAD_SETTINGS;
            } catch (error) {
                console.error('加载下载设置失败:', error);
                return CONFIG.DEFAULT_DOWNLOAD_SETTINGS;
            }
        },

        saveDownloadSettings(settings) {
            try {
                localStorage.setItem(CONFIG.STORAGE_KEYS.DOWNLOAD_SETTINGS, JSON.stringify(settings));
            } catch (error) {
                console.error('保存下载设置失败:', error);
            }
        }
    };

    let state = {
        currentVideo: { bvid: '', cid: '', title: '', duration: 0 },
        videoList: [],
        videoListType: 'single',
        subtitleList: [],
        subtitleDetails: [],
        modalOpenCount: 0,
        searchResults: [],
        currentSearchIndex: -1
    };

    function disableScroll() {
        state.modalOpenCount++;
        if (state.modalOpenCount === 1) {
            document.documentElement.style.setProperty('overflow', 'hidden', 'important');
            document.body.style.setProperty('overflow', 'hidden', 'important');
        }
    }

    function enableScroll() {
        state.modalOpenCount--;
        if (state.modalOpenCount <= 0) {
            state.modalOpenCount = 0;
            document.documentElement.style.removeProperty('overflow');
            document.body.style.removeProperty('overflow');
        }
    }

    class SubtitleCache {
        constructor(maxSize = CONFIG.CACHE_MAX_SIZE, maxAge = CONFIG.CACHE_MAX_AGE) {
            this.cache = new Map();
            this.maxSize = maxSize;
            this.maxAge = maxAge;
        }

        generateKey(bvid, cid, subtitleId) {
            return `${bvid}_${cid}_${subtitleId}`;
        }

        get(bvid, cid, subtitleId) {
            const key = this.generateKey(bvid, cid, subtitleId);
            const item = this.cache.get(key);
            if (!item) return null;
            if (Date.now() - item.timestamp > this.maxAge) {
                this.cache.delete(key);
                return null;
            }
            return item.data;
        }

        set(bvid, cid, subtitleId, data) {
            const key = this.generateKey(bvid, cid, subtitleId);
            if (this.cache.size >= this.maxSize) {
                const firstKey = this.cache.keys().next().value;
                this.cache.delete(firstKey);
            }
            this.cache.set(key, { data: data, timestamp: Date.now() });
        }

        clear(bvid, cid) {
            if (bvid && cid) {
                const prefix = `${bvid}_${cid}_`;
                for (const key of this.cache.keys()) {
                    if (key.startsWith(prefix)) {
                        this.cache.delete(key);
                    }
                }
            } else {
                this.cache.clear();
            }
        }
    }

    const subtitleCache = new SubtitleCache();

    class RequestDeduplicator {
        constructor() {
            this.pendingRequests = new Map();
        }

        async request(key, requestFn) {
            if (this.pendingRequests.has(key)) {
                return this.pendingRequests.get(key);
            }
            const promise = requestFn().finally(() => {
                this.pendingRequests.delete(key);
            });
            this.pendingRequests.set(key, promise);
            return promise;
        }
    }

    const deduplicator = new RequestDeduplicator();

    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `bili-transcript-toast bili-transcript-toast-${type}`;
        const icons = {
            success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>',
            error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
            warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v4M12 17h.01"/><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/></svg>',
            info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
        };
        toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-message">${message}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
            setTimeout(() => document.body.contains(toast) && toast.remove(), 300);
        }, duration);
    }

    function sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;');
    }

    function escapeCSV(value) {
        if (typeof value !== 'string') return '';
        return value.includes(',') || value.includes('"') || value.includes('\n')
            ? '"' + value.replace(/"/g, '""') + '"'
            : value;
    }

    function getCookies() {
        return Object.fromEntries(
            document.cookie.split(';').map(c => c.trim().split('=')).filter(([k, v]) => k && v)
        );
    }

    function getHeaders() {
        const cookies = getCookies();
        const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        return {
            'Referer': 'https://www.bilibili.com',
            'User-Agent': navigator.userAgent,
            'Cookie': cookieString.trim()
        };
    }

    async function request(url, options = {}) {
        const { timeout = CONFIG.REQUEST_TIMEOUT, retries = CONFIG.REQUEST_RETRIES, retryDelay = CONFIG.REQUEST_RETRY_DELAY, raw = false } = options;

        return new Promise((resolve, reject) => {
            let attempts = 0;

            function attempt() {
                attempts++;
                const timer = setTimeout(() => {
                    attempts <= retries ? setTimeout(attempt, retryDelay) : reject(new SubtitleError(ErrorTypes.NETWORK_ERROR, '请求超时'));
                }, timeout);

                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url: url,
                    headers: options.headers || getHeaders(),
                    timeout: timeout,
                    onload: (response) => {
                        clearTimeout(timer);
                        if (raw) return resolve(response.responseText);
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.code === 0) {
                                resolve(data);
                            } else if (data.code === -101) {
                                reject(new SubtitleError(ErrorTypes.AUTH_ERROR, '请重新登录B站'));
                            } else if (data.code === -404) {
                                reject(new SubtitleError(ErrorTypes.API_ERROR, '请求的资源不存在'));
                            } else {
                                reject(new SubtitleError(ErrorTypes.API_ERROR, data.message || 'API请求失败'));
                            }
                        } catch (e) {
                            reject(new SubtitleError(ErrorTypes.PARSE_ERROR, '响应数据格式错误', e));
                        }
                    },
                    onerror: (error) => {
                        clearTimeout(timer);
                        attempts <= retries ? setTimeout(attempt, retryDelay) : reject(new SubtitleError(ErrorTypes.NETWORK_ERROR, '网络请求失败', error));
                    },
                    ontimeout: () => {
                        clearTimeout(timer);
                        attempts <= retries ? setTimeout(attempt, retryDelay) : reject(new SubtitleError(ErrorTypes.NETWORK_ERROR, '请求超时'));
                    }
                });
            }

            attempt();
        });
    }

    async function getVideoInfo(bvid) {
        try {
            return await request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
        } catch (error) {
            const title = document.querySelector('.video-title')?.textContent;
            const cid = window.__INITIAL_STATE__?.videoData?.cid;
            if (title && cid) return { data: { title, cid } };
            throw error;
        }
    }

    async function getVideoPages(bvid) {
        try {
            const response = await request(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
            return response.data || [];
        } catch (error) {
            return [];
        }
    }

    async function fetchSubtitles(bvid, cid, forceRefresh = false) {
        const timestamp = Date.now();
        const url = forceRefresh
            ? `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}&_=${timestamp}`
            : `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`;

        const key = `subtitles_${bvid}_${cid}_${forceRefresh ? timestamp : ''}`;
        return deduplicator.request(key, async () => {
            const response = await request(url, {
                headers: {
                    'Referer': `https://www.bilibili.com/video/${bvid}/`,
                    'Origin': 'https://www.bilibili.com',
                    'Accept': 'application/json, text/plain, */*'
                }
            });
            return response.data?.subtitle?.subtitles?.map(s => parseSubtitleItem(s)) || [];
        });
    }

    async function fetchSubtitlesFromWebInterface(bvid, cid) {
        try {
            const response = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
            return response.data?.subtitle?.list?.map(s => parseSubtitleItem(s)) || [];
        } catch (error) {
            console.error('备用接口获取字幕失败:', error);
            return [];
        }
    }

    function parseSubtitleItem(subtitle) {
        return {
            id: subtitle.id,
            lan: subtitle.lan_doc || subtitle.lan,
            url: subtitle.subtitle_url || subtitle.url || subtitle.content_url || subtitle.caption_url || ''
        };
    }

    async function getSubtitleContent(url, bvid, cid, subtitleId) {
        const cached = subtitleCache.get(bvid, cid, subtitleId);
        if (cached) return cached;
        if (!url) return [];

        const fullUrl = url.startsWith('//') ? `https:${url}` : url;
        try {
            const response = await request(fullUrl, { raw: true });
            const data = JSON.parse(response);
            const content = data.body || [];
            if (content.length > 0) subtitleCache.set(bvid, cid, subtitleId, content);
            return content;
        } catch (error) {
            console.error('获取字幕内容失败:', error);
            return [];
        }
    }

    function parseTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return { h, m, s, ms };
    }

    function formatTime(seconds, format = 'srt') {
        const { h, m, s, ms } = parseTime(seconds);
        if (format === 'srt') {
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
        } else if (format === 'ass') {
            return `${h.toString().padStart(1, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
        } else if (format === 'lrc') {
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
        }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    // 格式转换函数
    function convertToSRT(content) {
        return content.map((item, index) => {
            const from = formatTime(item.from, 'srt');
            const to = formatTime(item.to, 'srt');
            return `${index + 1}\n${from} --> ${to}\n${item.content}\n`;
        }).join('\n');
    }

    function convertToTXT(content, includeTime = false) {
        return content.map(item => includeTime ? `${formatTime(item.from, 'srt')} ${item.content}` : item.content).join('\n');
    }

    function formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return h > 0 ? `${h}-${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}` : `${m}-${String(s).padStart(2, '0')}`;
    }

    function convertToJSON(content) {
        return JSON.stringify(content, null, 2);
    }

    function convertToVTT(content) {
        let vtt = 'WEBVTT\n\n';
        content.forEach((item, index) => {
            const from = formatTime(item.from, 'srt').replace(',', '.');
            const to = formatTime(item.to, 'srt').replace(',', '.');
            vtt += `${index + 1}\n${from} --> ${to}\n${item.content}\n\n`;
        });
        return vtt;
    }

    function convertToCSV(content) {
        let csv = '序号,开始时间,结束时间,字幕内容\n';
        content.forEach((item, index) => {
            const from = formatTime(item.from, 'srt');
            const to = formatTime(item.to, 'srt');
            csv += `${index + 1},${escapeCSV(from)},${escapeCSV(to)},${escapeCSV(item.content)}\n`;
        });
        return csv;
    }

    function convertToXML(content) {
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<subtitles>\n';
        content.forEach((item, index) => {
            const from = formatTime(item.from, 'srt');
            const to = formatTime(item.to, 'srt');
            xml += `  <subtitle id="${index + 1}" start="${from}" end="${to}">${sanitizeInput(item.content)}</subtitle>\n`;
        });
        xml += '</subtitles>';
        return xml;
    }

    function convertToASS(content, title = 'B站字幕') {
        let ass = `[Script Info]
Title: ${title}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,微软雅黑,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        content.forEach(item => {
            const from = formatTime(item.from, 'ass');
            const to = formatTime(item.to, 'ass');
            ass += `Dialogue: 0,${from},${to},Default,,0,0,0,,${item.content}\n`;
        });
        return ass;
    }

    function convertToLRC(content) {
        return content.map(item => `[${formatTime(item.from, 'lrc')}]${item.content}\n`).join('');
    }

    function downloadFile(content, filename, mimeType = 'text/plain') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(`字幕文件 "${filename.split('/').pop()}" 下载完成！`, 'success');
    }

    async function copyToClipboard(text) {
        try {
            await GM_setClipboard(text);
            showToast('复制成功', 'success');
        } catch (error) {
            console.error('复制失败:', error);
            showToast('复制失败', 'error');
        }
    }

    function getCurrentVideoInfo() {
        const url = window.location.href;
        const bvidMatch = url.match(/\/video\/(BV[a-zA-Z0-9]+)/);
        const bvid = bvidMatch ? bvidMatch[1] : '';

        let cid = window.player?.getCurrentVideo?.().cid?.toString() || '';
        if (!cid) cid = new URLSearchParams(window.location.search).get('cid') || '';

        const titleEl = document.querySelector('.video-title') || document.querySelector('h1');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const duration = document.querySelector('video')?.duration ? Math.floor(document.querySelector('video').duration) : 0;

        return { bvid, cid, title, duration };
    }

    function getVideoList() {
        const result = [];
        const videoPodBody = document.querySelector('.video-pod__body');

        if (videoPodBody) {
            videoPodBody.querySelectorAll('.video-pod__item, .pod-item').forEach((item, index) => {
                const link = item.querySelector('a');
                const titleEl = item.querySelector('.title .title-txt') || item.querySelector('.video-title');
                const dataKey = item.getAttribute('data-key');
                let bvid = '';

                if (link) {
                    const bvidMatch = link.getAttribute('href')?.match(/BV[a-zA-Z0-9]+/);
                    bvid = bvidMatch ? bvidMatch[0] : '';
                }
                if (!bvid && dataKey) {
                    const bvidMatch = dataKey.match(/BV[a-zA-Z0-9]+/);
                    bvid = bvidMatch ? bvidMatch[0] : '';
                }

                const title = titleEl ? titleEl.textContent.trim() : `视频 ${index + 1}`;
                if (bvid) result.push({ bvid, title, cid: '' });
            });
        }

        if (result.length === 0) {
            const playerPages = window.__INITIAL_STATE__?.videoData?.pages;
            if (Array.isArray(playerPages) && playerPages.length > 0) {
                playerPages.forEach((page, index) => {
                    result.push({
                        bvid: state.currentVideo.bvid,
                        cid: page.cid?.toString() || '',
                        title: page.part || `P${index + 1}`
                    });
                });
            }
        }

        return result;
    }

    async function getVideoCID(bvid) {
        try {
            const videoInfo = await getVideoInfo(bvid);
            return videoInfo.data?.cid || '';
        } catch (error) {
            console.error('获取CID失败:', error);
            return '';
        }
    }

    function sortSubtitles(subtitles) {
        return [...subtitles].filter(s => s.url?.trim()).sort((a, b) => {
            const aIsSummary = a.lan.includes('摘要');
            const bIsSummary = b.lan.includes('摘要');
            const aIsAI = a.lan.includes('AI');
            const bIsAI = b.lan.includes('AI');
            const aIsChinese = a.lan.includes('中文');
            const bIsChinese = b.lan.includes('中文');

            if (aIsSummary !== bIsSummary) return aIsSummary ? 1 : -1;
            if (aIsAI !== bIsAI) return aIsAI ? 1 : -1;
            if (aIsChinese !== bIsChinese) return aIsChinese ? -1 : 1;
            return 0;
        });
    }

    function isSubtitleMismatch(content, videoDuration) {
        if (content.length === 0 || videoDuration === 0) return false;
        const lastSubtitle = content[content.length - 1];
        const subtitleDuration = lastSubtitle.end || lastSubtitle.to || 0;
        const durationRatio = subtitleDuration / videoDuration;
        return durationRatio < 0.5 || durationRatio > 1.5;
    }

    // 字幕搜索功能
    function searchSubtitles(keyword) {
        if (!keyword?.trim()) {
            state.searchResults = [];
            state.currentSearchIndex = -1;
            renderSubtitles(state.subtitleDetails);
            return;
        }

        const lowerKeyword = keyword.toLowerCase();
        state.searchResults = state.subtitleDetails.filter(item =>
            item.content.toLowerCase().includes(lowerKeyword)
        );
        state.currentSearchIndex = state.searchResults.length > 0 ? 0 : -1;

        renderSubtitlesWithHighlight(keyword);
        updateSearchStatus();

        if (state.searchResults.length > 0) {
            scrollToSearchResult(0);
        } else {
            showToast('未找到匹配的字幕', 'info');
        }
    }

    function renderSubtitlesWithHighlight(keyword) {
        const container = document.getElementById('subtitle-content');
        if (!container) return;

        if (!state.subtitleDetails?.length) {
            showNoSubtitles();
            return;
        }

        const lowerKeyword = keyword.toLowerCase();
        const subtitleHtml = state.subtitleDetails.map((item, index) => {
            const time = formatTime(item.from);
            const isHighlighted = item.content.toLowerCase().includes(lowerKeyword);
            const highlightedContent = item.content.replace(
                new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                '<span class="highlight">$1</span>'
            );

            return `
                <div class="subtitle-item ${isHighlighted ? 'search-match' : ''}" data-index="${index}" data-time="${item.from}">
                    <span class="subtitle-time">[${time}]</span>
                    <span class="subtitle-text">${highlightedContent}</span>
                </div>
            `;
        }).join('');

        container.innerHTML = `<div class="subtitle-list">${subtitleHtml}</div>`;
        bindSubtitleClickEvents();
    }

    function updateSearchStatus() {
        const statusEl = document.getElementById('search-status');
        if (!statusEl) return;
        statusEl.textContent = state.searchResults.length === 0
            ? '0/0'
            : `${state.currentSearchIndex + 1}/${state.searchResults.length}`;
    }

    function scrollToSearchResult(index) {
        if (index < 0 || index >= state.searchResults.length) return;

        const result = state.searchResults[index];
        const itemIndex = state.subtitleDetails.indexOf(result);
        const item = document.querySelector(`.subtitle-item[data-index="${itemIndex}"]`);

        if (item) {
            document.querySelectorAll('.subtitle-item.search-selected').forEach(el => el.classList.remove('search-selected'));
            item.classList.add('search-selected');
            item.scrollIntoView({ behavior: 'smooth', block: 'center' });

            const video = document.querySelector('video');
            const time = parseFloat(item.getAttribute('data-time'));
            if (video && !isNaN(time)) video.currentTime = time;
        }
    }

    function nextSearchResult() {
        if (state.searchResults.length === 0) return;
        state.currentSearchIndex = (state.currentSearchIndex + 1) % state.searchResults.length;
        updateSearchStatus();
        scrollToSearchResult(state.currentSearchIndex);
    }

    function prevSearchResult() {
        if (state.searchResults.length === 0) return;
        state.currentSearchIndex = (state.currentSearchIndex - 1 + state.searchResults.length) % state.searchResults.length;
        updateSearchStatus();
        scrollToSearchResult(state.currentSearchIndex);
    }

    async function loadSubtitles(retryCount = 0) {
        state.subtitleDetails = [];
        state.subtitleList = [];
        state.searchResults = [];
        state.currentSearchIndex = -1;

        let { bvid, cid } = state.currentVideo;
        if (!bvid) {
            showToast('无法获取视频信息', 'error');
            return;
        }

        if (!cid) {
            cid = await getVideoCID(bvid);
            if (!cid) {
                showToast('无法获取视频信息', 'error');
                return;
            }
            state.currentVideo.cid = cid;
        }

        showToast('正在加载字幕...', 'info');

        try {
            if (retryCount > 0) subtitleCache.clear(bvid, cid);

            let subtitles = await fetchSubtitles(bvid, cid, retryCount > 0);
            if (subtitles.length === 0) subtitles = await fetchSubtitlesFromWebInterface(bvid, cid);

            const video = document.querySelector('video');
            const videoDuration = video?.duration ? Math.floor(video.duration) : state.currentVideo.duration;
            if (video?.duration) state.currentVideo.duration = videoDuration;

            updateVideoInfo();

            if (subtitles.length === 0) {
                showNoSubtitles();
                return;
            }

            state.subtitleList = subtitles;
            showVideoListSelector();
            showSubtitlesSelector(subtitles);

            const sortedSubtitles = sortSubtitles(subtitles);
            let selectedSubtitle = null;
            let content = [];

            for (const subtitle of sortedSubtitles) {
                const subtitleContent = await getSubtitleContent(subtitle.url, bvid, cid, subtitle.id);
                if (subtitleContent.length === 0) continue;

                const lastSubtitle = subtitleContent[subtitleContent.length - 1];
                const subtitleDuration = lastSubtitle.end || lastSubtitle.to || 0;
                const durationRatio = videoDuration > 0 ? subtitleDuration / videoDuration : 0;

                if (videoDuration > 0 && durationRatio >= 0.5 && durationRatio <= 1.5) {
                    selectedSubtitle = subtitle;
                    content = subtitleContent;
                    break;
                }

                if (videoDuration === 0 && !selectedSubtitle) {
                    selectedSubtitle = subtitle;
                    content = subtitleContent;
                    break;
                }
            }

            if (!selectedSubtitle && sortedSubtitles.length > 0) {
                selectedSubtitle = sortedSubtitles[0];
                content = await getSubtitleContent(selectedSubtitle.url, bvid, cid, selectedSubtitle.id);
            }

            if (!selectedSubtitle) {
                showToast('无法获取字幕内容', 'error');
                return;
            }

            if (isSubtitleMismatch(content, videoDuration) && retryCount < 3) {
                showToast(`字幕不匹配，正在重试 (${retryCount + 1}/3)...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, 1000));
                return loadSubtitles(retryCount + 1);
            }

            if (isSubtitleMismatch(content, videoDuration) && retryCount >= 3) {
                showToast('警告：字幕与视频时长可能不匹配', 'warning');
            }

            state.subtitleDetails = content;
            renderSubtitles(content);
            updateVideoInfo();
            showToast('字幕加载完成', 'success');

        } catch (error) {
            console.error('加载字幕失败:', error);
            showToast('加载字幕失败', 'error');
        }
    }

    function showNoSubtitles() {
        const container = document.getElementById('subtitle-content');
        if (!container) return;

        container.innerHTML = `
            <div class="no-subtitles">
                <div class="no-subtitles-icon">📭</div>
                <h3>未找到字幕</h3>
                <p>当前视频没有可用的字幕</p>
                <ul class="no-subtitles-tips">
                    <li>视频未上传字幕</li>
                    <li>需要登录才能查看字幕</li>
                    <li>字幕正在生成中</li>
                </ul>
            </div>
        `;
    }

    function showVideoListSelector() {
        const container = document.getElementById('video-list-selector');
        if (!container) return;

        const videoList = state.videoList;
        if (!videoList || videoList.length <= 1) {
            container.innerHTML = '';
            return;
        }

        const currentBvid = state.currentVideo.bvid;
        const options = videoList.map((video, index) => {
            const isSelected = video.bvid === currentBvid;
            return `<option value="${video.bvid}" data-cid="${video.cid}" ${isSelected ? 'selected' : ''}>${index + 1}. ${sanitizeInput(video.title).substring(0, 30)}${video.title.length > 30 ? '...' : ''}</option>`;
        }).join('');

        container.innerHTML = `<select id="video-select" class="video-select">${options}</select>`;

        document.getElementById('video-select')?.addEventListener('change', async (e) => {
            const selectedBvid = e.target.value;
            const selectedCid = e.target.options[e.target.selectedIndex].getAttribute('data-cid');
            const video = videoList.find(v => v.bvid === selectedBvid);

            if (video) {
                state.currentVideo.bvid = selectedBvid;
                state.currentVideo.cid = selectedCid || '';
                state.currentVideo.title = video.title;
                state.currentVideo.duration = 0;

                if (!state.currentVideo.cid) {
                    const cid = await getVideoCID(selectedBvid);
                    if (cid) state.currentVideo.cid = cid;
                }

                await loadSubtitles();
            }
        });
    }

    function showSubtitlesSelector(subtitles) {
        const container = document.getElementById('subtitle-selector');
        if (!container) return;

        if (!subtitles || subtitles.length <= 1) {
            container.innerHTML = '';
            return;
        }

        const options = subtitles.map((subtitle, index) => {
            const hasUrl = subtitle.url?.trim();
            return `<div class="custom-select-option" data-value="${index}" ${!hasUrl ? 'class="custom-select-option disabled"' : ''}>${subtitle.lan}${hasUrl ? '' : ' (不可用)'}</div>`;
        }).join('');

        const defaultIndex = subtitles.findIndex(s => s.url?.trim());
        const defaultSubtitle = subtitles[defaultIndex >= 0 ? defaultIndex : 0];

        container.innerHTML = `
            <div class="custom-select">
                <div class="custom-select-trigger" id="subtitle-select-trigger">
                    <span class="custom-select-value">${defaultSubtitle.lan}</span>
                    <span class="custom-select-icon-wrapper">
                        <svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
                </div>
                <div class="custom-select-dropdown" id="subtitle-select-dropdown">${options}</div>
            </div>
        `;

        const customSelect = container.querySelector('.custom-select');
        const trigger = document.getElementById('subtitle-select-trigger');
        const dropdown = document.getElementById('subtitle-select-dropdown');
        const valueSpan = trigger.querySelector('.custom-select-value');

        const toggleDropdown = () => {
            dropdown.classList.toggle('active');
            customSelect.classList.toggle('active');
        };

        trigger.addEventListener('click', toggleDropdown);
        document.addEventListener('click', (e) => !container.contains(e.target) && dropdown.classList.remove('active') && customSelect.classList.remove('active'));

        dropdown.querySelectorAll('.custom-select-option:not(.disabled)').forEach(option => {
            option.addEventListener('click', async () => {
                const index = parseInt(option.dataset.value);
                const subtitle = subtitles[index];
                if (subtitle?.url) {
                    valueSpan.textContent = subtitle.lan;
                    dropdown.classList.remove('active');
                    customSelect.classList.remove('active');
                    const content = await getSubtitleContent(subtitle.url, state.currentVideo.bvid, state.currentVideo.cid, subtitle.id);
                    state.subtitleDetails = content;
                    state.searchResults = [];
                    state.currentSearchIndex = -1;
                    renderSubtitles(content);
                }
            });
        });
    }

    function bindSubtitleClickEvents() {
        document.querySelectorAll('.subtitle-item').forEach(item => {
            item.addEventListener('click', () => {
                const video = document.querySelector('video');
                const time = parseFloat(item.getAttribute('data-time'));
                if (video && !isNaN(time)) {
                    video.currentTime = time;
                    video.play();
                }
            });
        });
    }

    function renderSubtitles(content) {
        const container = document.getElementById('subtitle-content');
        if (!container) return;

        if (!content?.length) {
            showNoSubtitles();
            return;
        }

        const subtitleHtml = content.map((item, index) => {
            const time = formatTime(item.from);
            return `
                <div class="subtitle-item" data-index="${index}" data-time="${item.from}">
                    <span class="subtitle-time">[${time}]</span>
                    <span class="subtitle-text">${sanitizeInput(item.content)}</span>
                </div>
            `;
        }).join('');

        container.innerHTML = `<div class="subtitle-list">${subtitleHtml}</div>`;
        bindSubtitleClickEvents();
    }

    function updateVideoInfo() {
        const { bvid, cid, title, duration } = state.currentVideo;
        document.getElementById('video-title').textContent = sanitizeInput(title) || '未知标题';
        document.getElementById('video-bvid').textContent = bvid || '未知';
        document.getElementById('video-cid').textContent = cid || '未知';
        document.getElementById('video-duration').textContent = duration ? formatTime(duration) : '未知';
    }

    function createModal() {
        removeModal('bili-transcript-modal');
        disableScroll();

        const modal = document.createElement('div');
        modal.id = 'bili-transcript-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="modal-overlay"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h2><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="modal-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> 字幕提取器</h2>
                    <button id="close-modal" class="close-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                <div class="modal-body">
                    <div class="video-info">
                        <div class="info-row"><span class="info-label">标题</span><span id="video-title" class="info-value">加载中...</span></div>
                        <div class="info-row"><span class="info-label">BV号</span><span id="video-bvid" class="info-value">加载中...</span></div>
                        <div class="info-row"><span class="info-label">CID</span><span id="video-cid" class="info-value">加载中...</span></div>
                        <div class="info-row"><span class="info-label">时长</span><span id="video-duration" class="info-value">加载中...</span></div>
                    </div>
                    <div id="video-list-selector" class="selector-container"></div>
                    <div id="subtitle-selector" class="selector-container"></div>

                    <div class="search-container">
                        <div class="search-input-wrapper">
                            <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="11" cy="11" r="8"/>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                            </svg>
                            <input type="text" id="subtitle-search" class="search-input" placeholder="搜索字幕...">
                            <div class="search-nav">
                                <button id="search-prev" class="search-nav-btn" title="上一个">↑</button>
                                <span id="search-status" class="search-status">0/0</span>
                                <button id="search-next" class="search-nav-btn" title="下一个">↓</button>
                            </div>
                        </div>
                    </div>

                    <div class="subtitle-content-wrapper">
                        <div id="subtitle-content" class="subtitle-content">
                            <div class="loading"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="loading-spinner"><circle class="loading-path" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="50" stroke-dashoffset="0"/></svg> 加载中...</div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="settings-btn" class="btn-secondary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 设置</button>
                    <button id="copy-text" class="btn-primary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制</button>
                    <button id="download-txt" class="btn-secondary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 下载</button>
                    <button id="batch-download" class="btn-primary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> 批量</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-modal', 'modal-overlay');

        // 绑定搜索事件
        const searchInput = document.getElementById('subtitle-search');
        const searchPrev = document.getElementById('search-prev');
        const searchNext = document.getElementById('search-next');

        searchInput.addEventListener('input', (e) => searchSubtitles(e.target.value));
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') e.shiftKey ? prevSearchResult() : nextSearchResult();
        });

        searchPrev.addEventListener('click', prevSearchResult);
        searchNext.addEventListener('click', nextSearchResult);

        document.getElementById('copy-text').addEventListener('click', async () => {
            await copyToClipboard(convertToTXT(state.subtitleDetails));
        });

        document.getElementById('download-txt').addEventListener('click', () => {
            showDownloadConfirm(state.subtitleDetails, state.subtitleDetails);
        });

        document.getElementById('settings-btn').addEventListener('click', showSettingsModal);

        const batchBtn = document.getElementById('batch-download');
        if (batchBtn) {
            if (state.videoList?.length > 1) {
                batchBtn.addEventListener('click', showBatchDownloadModal);
            } else {
                batchBtn.style.display = 'none';
            }
        }

        loadSubtitles();
    }

    function removeModal(modalId) {
        const existingModal = document.getElementById(modalId);
        if (existingModal) {
            existingModal.remove();
            if (modalId === 'bili-transcript-modal' || modalId === 'bili-transcript-batch-modal') {
                enableScroll();
            }
        }
    }

    function setupModalClose(modal, closeBtnId, overlayId) {
        const closeModal = () => {
            modal.style.opacity = '0';
            enableScroll();
            setTimeout(() => document.body.contains(modal) && modal.remove(), 300);
        };

        document.getElementById(closeBtnId)?.addEventListener('click', closeModal);
        document.getElementById(overlayId)?.addEventListener('click', closeModal);
    }

    function showDownloadConfirm(content, originalData) {
        removeModal('bili-transcript-download-modal');
        disableScroll();

        const settings = StorageManager.getDownloadSettings();
        const title = state.currentVideo.title.replace(/[\\/:*?"<>|]/g, '_') || 'subtitle';
        const bvid = state.currentVideo.bvid;
        const duration = state.currentVideo.duration;

        const modal = document.createElement('div');
        modal.id = 'bili-transcript-download-modal';
        modal.className = 'bili-transcript-modal';

        const downloadMethods = [
            { value: 'direct', name: '直接下载' },
            { value: 'newtab', name: '新标签页打开' }
        ];

        modal.innerHTML = `
            <div class="modal-overlay" id="download-overlay"></div>
            <div class="modal-content download-modal">
                <div class="modal-header">
                    <h2><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 下载字幕</h2>
                    <button id="close-download-modal" class="close-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                <div class="modal-body">
                    <div class="download-section">
                        <label class="download-label">文件名:</label>
                        <input type="text" id="download-filename" value="${sanitizeInput(title)}" class="download-input">
                    </div>
                    <div class="download-section">
                        <label class="download-label">输出格式:</label>
                        <div class="download-format-display">
                            <span>${settings.format.toUpperCase()}</span>
                            <span class="format-hint">(可在设置中修改)</span>
                        </div>
                    </div>
                    <div class="download-section">
                        <label class="download-label">下载方式:</label>
                        <div class="download-methods">
                            ${downloadMethods.map(method =>
            `<label class="download-method-label">
                                    <input type="radio" name="download-method" value="${method.value}" ${settings.downloadMethod === method.value ? 'checked' : ''}>
                                    <span>${method.name}</span>
                                </label>`
        ).join('')}
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="download-settings-btn" class="btn-secondary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 设置</button>
                    <button id="confirm-download" class="btn-primary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-download-modal', 'download-overlay');

        const filenameInput = document.getElementById('download-filename');
        const downloadBtn = document.getElementById('confirm-download');

        const updateFilename = () => {
            let baseName = title;
            if (settings.includeBV && bvid) baseName = `${title}_${bvid}`;
            if (settings.includeTimestamp) {
                const now = new Date();
                const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
                baseName = `${baseName}_${timestamp}`;
            }
            if (settings.includeDuration && duration > 0) {
                const durationStr = formatDuration(duration);
                baseName = `${baseName}_${durationStr}`;
            }
            filenameInput.value = `${baseName}.${settings.format}`;
        };

        document.querySelectorAll('input[name="download-method"]').forEach(radio => {
            radio.addEventListener('change', () => {
                settings.downloadMethod = radio.value;
                StorageManager.saveDownloadSettings(settings);
                downloadBtn.textContent = radio.value === 'direct' ? '下载' : '打开';
            });
        });

        document.getElementById('download-settings-btn').addEventListener('click', () => {
            modal.remove();
            showSettingsModal();
        });

        downloadBtn.addEventListener('click', () => {
            const format = settings.format;
            const allExtensions = [
                ...CONFIG.PRESET_EXTENSIONS,
                ...StorageManager.getCustomExtensions()
            ];
            const matchedExt = allExtensions.find(ext => ext.value === format);
            const mimeType = matchedExt ? matchedExt.mimeType : 'text/plain';
            const filename = filenameInput.value || `${title}.${format}`;

            let convertedContent;
            switch (format) {
                case 'json': convertedContent = convertToJSON(originalData); break;
                case 'srt': convertedContent = convertToSRT(content); break;
                case 'vtt': convertedContent = convertToVTT(content); break;
                case 'csv': convertedContent = convertToCSV(content); break;
                case 'xml': convertedContent = convertToXML(content); break;
                case 'ass': convertedContent = convertToASS(content, state.currentVideo.title); break;
                case 'lrc': convertedContent = convertToLRC(content); break;
                case 'html':
                    convertedContent = settings.includeSubtitleTime
                        ? content.map(item => `${formatTime(item.from, 'srt')} ${item.content}`).join('<br>\n')
                        : content.map(item => item.content).join('<br>\n');
                    break;
                default:
                    convertedContent = convertToTXT(content, settings.includeSubtitleTime);
            }

            const downloadMethod = document.querySelector('input[name="download-method"]:checked').value;
            modal.remove();
            handleDownload(convertedContent, filename, mimeType, downloadMethod);
        });

        updateFilename();
    }

    function handleDownload(content, filename, mimeType, method) {
        switch (method) {
            case 'direct':
                downloadFile(content, filename, mimeType);
                break;
            case 'newtab':
                const blob = new Blob(['\uFEFF' + content], { type: `${mimeType};charset=UTF-8` });
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank');
                setTimeout(() => URL.revokeObjectURL(url), 100);
                showToast('已在新标签页打开', 'success');
                break;
        }
    }

    function createCustomExtensionDialog(onSuccess) {
        const modal = document.createElement('div');
        modal.id = 'custom-extension-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="custom-ext-overlay"></div>
            <div class="modal-content custom-ext-modal">
                <div class="modal-header">
                    <h2><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v16m8-8H4"/></svg> 添加自定义扩展名</h2>
                    <button id="close-custom-ext-modal" class="close-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                <div class="modal-body">
                    <div class="custom-ext-section">
                        <label class="custom-ext-label">扩展名:</label>
                        <input type="text" id="custom-ext-input" placeholder="输入扩展名（不含点，如：txt、md）" class="custom-ext-input">
                    </div>
                    <div class="custom-ext-section">
                        <label class="custom-ext-label">MIME 类型:</label>
                        <input type="text" id="custom-mime-input" placeholder="输入 MIME 类型（如：text/plain）" class="custom-ext-input">
                        <p class="mime-hint">常用 MIME 类型参考：text/plain, text/markdown, text/html, application/json</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="cancel-custom-ext" class="btn-secondary">取消</button>
                    <button id="confirm-custom-ext" class="btn-primary">添加</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const closeModal = () => {
            modal.remove();
            enableScroll();
        };

        document.getElementById('close-custom-ext-modal').addEventListener('click', closeModal);
        document.getElementById('custom-ext-overlay').addEventListener('click', closeModal);
        document.getElementById('cancel-custom-ext').addEventListener('click', closeModal);

        document.getElementById('confirm-custom-ext').addEventListener('click', () => {
            const extInput = document.getElementById('custom-ext-input');
            const mimeInput = document.getElementById('custom-mime-input');
            const value = extInput.value.trim().toLowerCase();
            const mimeType = mimeInput.value.trim() || 'text/plain';

            if (!value) {
                showToast('请输入扩展名', 'warning');
                return;
            }

            addCustomExtension({ name: value.toUpperCase(), value, mimeType });
            closeModal();
            onSuccess({ value, name: value.toUpperCase() });
        });
    }

    function addCustomExtension(ext) {
        const extensions = StorageManager.getCustomExtensions();
        if (!extensions.find(e => e.value === ext.value)) {
            extensions.push(ext);
            StorageManager.saveCustomExtensions(extensions);
        }
    }

    function showSettingsModal() {
        removeModal('bili-transcript-settings-modal');
        disableScroll();

        const settings = StorageManager.getDownloadSettings();
        const customExtensions = StorageManager.getCustomExtensions();

        const modal = document.createElement('div');
        modal.id = 'bili-transcript-settings-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="settings-overlay"></div>
            <div class="modal-content settings-modal">
                <div class="modal-header">
                    <h2><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> 下载设置</h2>
                    <button id="close-settings-modal" class="close-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                <div class="modal-body">
                    <div class="settings-section">
                        <div class="settings-header">
                            <h3>输出格式</h3>
                            <button id="add-custom-ext-btn" class="btn-small">添加</button>
                        </div>
                        <div id="format-list" class="format-list">
                            ${CONFIG.PRESET_EXTENSIONS.map(ext => `
                                <div class="format-item ${settings.format === ext.value ? 'selected' : ''}" data-value="${ext.value}" data-default="true" data-mime="${ext.mimeType}">
                                    <span class="format-name">${ext.name}</span>
                                </div>
                            `).join('')}
                            ${customExtensions.map((ext, index) => `
                                <div class="format-item ${settings.format === ext.value ? 'selected' : ''}" data-value="${ext.value}" data-custom="true" data-index="${index}" data-mime="${ext.mimeType}">
                                    <span class="format-name">${ext.name}</span>
                                    <button class="remove-ext-btn">删除</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="settings-section">
                        <h3>默认下载方式</h3>
                        <div class="download-methods">
                            <label class="download-method-label">
                                <input type="radio" name="default-method" value="direct" ${settings.downloadMethod === 'direct' ? 'checked' : ''}>
                                <span>直接下载</span>
                            </label>
                            <label class="download-method-label">
                                <input type="radio" name="default-method" value="newtab" ${settings.downloadMethod === 'newtab' ? 'checked' : ''}>
                                <span>新标签页打开</span>
                            </label>
                        </div>
                    </div>
                    <div class="settings-section">
                        <h3>字幕内容设置</h3>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-subtitle-time" ${settings.includeSubtitleTime ? 'checked' : ''}>
                            <span>包含字幕时间</span>
                        </label>
                    </div>
                    <div class="settings-section">
                        <h3>文件名设置</h3>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-bv" ${settings.includeBV ? 'checked' : ''}>
                            <span>文件名包含BV号</span>
                        </label>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-timestamp" ${settings.includeTimestamp ? 'checked' : ''}>
                            <span>文件名包含当前时间</span>
                        </label>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-duration" ${settings.includeDuration ? 'checked' : ''}>
                            <span>文件名包含视频时长</span>
                        </label>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="reset-settings" class="btn-secondary">恢复默认</button>
                    <button id="save-settings" class="btn-primary">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-settings-modal', 'settings-overlay');

        document.querySelectorAll('.format-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('remove-ext-btn')) return;
                document.querySelectorAll('.format-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                settings.format = item.getAttribute('data-value');
            });
        });

        document.querySelectorAll('.format-item .remove-ext-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = btn.closest('.format-item');
                const index = parseInt(item.getAttribute('data-index'));
                const extensions = StorageManager.getCustomExtensions();
                const removedValue = extensions[index].value;

                extensions.splice(index, 1);
                StorageManager.saveCustomExtensions(extensions);

                if (settings.format === removedValue) {
                    settings.format = 'txt';
                    StorageManager.saveDownloadSettings(settings);
                }

                modal.remove();
                showSettingsModal();
            });
        });

        document.querySelectorAll('input[name="default-method"]').forEach(radio => {
            radio.addEventListener('change', () => {
                settings.downloadMethod = radio.value;
            });
        });

        document.getElementById('settings-include-bv').addEventListener('change', () => {
            settings.includeBV = document.getElementById('settings-include-bv').checked;
        });

        document.getElementById('settings-include-subtitle-time').addEventListener('change', () => {
            settings.includeSubtitleTime = document.getElementById('settings-include-subtitle-time').checked;
        });

        document.getElementById('settings-include-timestamp').addEventListener('change', () => {
            settings.includeTimestamp = document.getElementById('settings-include-timestamp').checked;
        });

        document.getElementById('settings-include-duration').addEventListener('change', () => {
            settings.includeDuration = document.getElementById('settings-include-duration').checked;
        });

        document.getElementById('add-custom-ext-btn').addEventListener('click', () => {
            createCustomExtensionDialog(() => {
                modal.remove();
                showSettingsModal();
            });
        });

        document.getElementById('reset-settings').addEventListener('click', () => {
            Object.assign(settings, CONFIG.DEFAULT_DOWNLOAD_SETTINGS);
            StorageManager.saveCustomExtensions([]);
            modal.remove();
            showSettingsModal();
            showToast('已恢复默认设置', 'success');
        });

        document.getElementById('save-settings').addEventListener('click', () => {
            StorageManager.saveDownloadSettings(settings);
            modal.remove();
            showToast('设置已保存', 'success');
        });
    }

    function showBatchDownloadModal() {
        disableScroll();

        let videoList = state.videoList;
        if (!videoList?.length) {
            videoList = [{
                bvid: state.currentVideo.bvid,
                cid: state.currentVideo.cid,
                title: state.currentVideo.title
            }];
        }

        const modal = document.createElement('div');
        modal.id = 'batch-download-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="batch-overlay"></div>
            <div class="modal-content batch-modal">
                <div class="modal-header">
                    <h2><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> 批量下载字幕</h2>
                    <button id="close-batch-modal" class="close-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                <div class="modal-body">
                    <div class="batch-section">
                        <div class="batch-header">
                            <h3>选择视频 (${videoList.length}个)</h3>
                            <div class="batch-actions">
                                <button id="select-all" class="btn-small">全选</button>
                                <button id="deselect-all" class="btn-small">取消全选</button>
                            </div>
                        </div>
                        <div id="video-checkboxes" class="checkbox-list"></div>
                    </div>
                    <div class="batch-section">
                        <h3>字幕语言</h3>
                        <div class="custom-select" id="batch-language-container">
                            <div class="custom-select-trigger" id="batch-language-trigger">
                                <span class="custom-select-value">自动选择</span>
                                <span class="custom-select-icon-wrapper">
                                    <svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                                </span>
                            </div>
                            <div class="custom-select-dropdown" id="batch-language-dropdown">
                                <div class="custom-select-option" data-value="auto">自动选择</div>
                            </div>
                        </div>
                        <input type="hidden" id="batch-language" value="auto">
                    </div>
                    <div class="batch-section">
                        <h3>输出格式</h3>
                        <div style="padding: 12px 14px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; font-size: 14px; color: var(--text-secondary);">
                            当前设置: <span style="color: var(--text-primary); font-weight: 500;">${StorageManager.getDownloadSettings().format.toUpperCase()}</span>
                            <span style="margin-left: 8px; font-size: 12px; color: var(--text-muted);">(可在设置中修改)</span>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="start-batch-download" class="btn-primary"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 开始下载</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-batch-modal', 'batch-overlay');

        const batchLanguageContainer = document.getElementById('batch-language-container');
        const batchLanguageTrigger = document.getElementById('batch-language-trigger');
        const batchLanguageDropdown = document.getElementById('batch-language-dropdown');
        const batchLanguageValue = batchLanguageTrigger.querySelector('.custom-select-value');
        const batchLanguageHidden = document.getElementById('batch-language');

        const toggleBatchLanguageDropdown = () => {
            batchLanguageDropdown.classList.toggle('active');
            batchLanguageContainer.classList.toggle('active');
        };

        batchLanguageTrigger.addEventListener('click', toggleBatchLanguageDropdown);
        document.addEventListener('click', (e) => !batchLanguageContainer.contains(e.target) && batchLanguageDropdown.classList.remove('active') && batchLanguageContainer.classList.remove('active'));

        batchLanguageDropdown.querySelectorAll('.custom-select-option').forEach(option => {
            option.addEventListener('click', () => {
                const value = option.dataset.value;
                batchLanguageValue.textContent = option.textContent;
                batchLanguageHidden.value = value;
                batchLanguageDropdown.classList.remove('active');
                batchLanguageContainer.classList.remove('active');
            });
        });

        const videoCheckboxes = document.getElementById('video-checkboxes');
        if (videoList.length === 0) {
            videoCheckboxes.innerHTML = `<p style="color: var(--text-muted); text-align: center;">暂无可选视频</p>`;
        } else {
            videoList.forEach((video, index) => {
                const checkbox = document.createElement('label');
                checkbox.className = 'checkbox-item';
                const title = video.title || '未知标题';
                checkbox.innerHTML = `<input type="checkbox" value="${video.bvid}" data-cid="${video.cid || ''}" checked> ${index + 1}. ${sanitizeInput(title).substring(0, 40)}${title.length > 40 ? '...' : ''}`;
                videoCheckboxes.appendChild(checkbox);
            });
        }

        document.getElementById('select-all').addEventListener('click', () => {
            document.querySelectorAll('#video-checkboxes input').forEach(cb => cb.checked = true);
        });

        document.getElementById('deselect-all').addEventListener('click', () => {
            document.querySelectorAll('#video-checkboxes input').forEach(cb => cb.checked = false);
        });

        document.getElementById('start-batch-download').addEventListener('click', batchDownloadSubtitles);

        async function batchDownloadSubtitles() {
            const selectedVideos = Array.from(document.querySelectorAll('#video-checkboxes input:checked'))
                .map(cb => ({
                    bvid: cb.value,
                    cid: cb.getAttribute('data-cid') || ''
                }));

            const settings = StorageManager.getDownloadSettings();
            const format = settings.format;

            if (selectedVideos.length === 0) {
                showToast('请选择至少一个视频', 'warning');
                return;
            }

            showToast(`开始下载 ${selectedVideos.length} 个视频的字幕...`, 'info');

            for (const video of selectedVideos) {
                try {
                    await downloadVideoSubtitle(video, format, settings);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                    console.error(`下载 ${video.bvid} 字幕失败:`, error);
                }
            }

            showToast('批量下载完成', 'success');
            removeModal('batch-download-modal');
        }
    }

    async function downloadVideoSubtitle(video, format, settings) {
        let cid = video.cid;
        if (!cid) cid = await getVideoCID(video.bvid);
        if (!cid) return;

        let subtitles = await fetchSubtitles(video.bvid, cid);
        if (subtitles.length === 0) return;

        const selectedSubtitle = subtitles.find(s => !s.lan.includes('摘要') && !s.lan.includes('AI') && s.lan.includes('中文')) || subtitles[0];
        if (!selectedSubtitle.url) return;

        const content = await getSubtitleContent(selectedSubtitle.url, video.bvid, cid, selectedSubtitle.id);
        if (content.length === 0) return;

        const videoInfo = await getVideoInfo(video.bvid);
        const title = videoInfo.data?.title || video.bvid;
        const duration = videoInfo.data?.duration || 0;

        let filename = title.replace(/[\\/:*?"<>|]/g, '_');
        if (settings.includeBV && video.bvid) filename = `${filename}_${video.bvid}`;
        if (settings.includeTimestamp) {
            const now = new Date();
            const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            filename = `${filename}_${timestamp}`;
        }
        if (settings.includeDuration && duration > 0) {
            const durationStr = formatDuration(duration);
            filename = `${filename}_${durationStr}`;
        }

        let convertedContent;
        let mimeType = 'text/plain';

        switch (format) {
            case 'srt': convertedContent = convertToSRT(content); mimeType = 'text/x-subrip'; break;
            case 'vtt': convertedContent = convertToVTT(content); mimeType = 'text/vtt'; break;
            case 'json': convertedContent = convertToJSON(content); mimeType = 'application/json'; break;
            case 'csv': convertedContent = convertToCSV(content); mimeType = 'text/csv'; break;
            case 'xml': convertedContent = convertToXML(content); mimeType = 'application/xml'; break;
            case 'ass': convertedContent = convertToASS(content, title); mimeType = 'text/x-ass'; break;
            case 'lrc': convertedContent = convertToLRC(content); mimeType = 'text/lrc'; break;
            default: convertedContent = convertToTXT(content, settings.includeSubtitleTime);
        }

        downloadFile(convertedContent, `${filename}.${format}`, mimeType);
    }

    function createFloatButton() {
        removeModal('bili-transcript-btn');

        const btn = document.createElement('button');
        btn.id = 'bili-transcript-btn';
        btn.className = 'bili-transcript-btn';
        btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
        btn.title = '提取字幕';
        btn.addEventListener('click', createModal);
        document.body.appendChild(btn);
    }

    function initVideoList() {
        const videos = getVideoList();
        if (videos.length > 1) {
            state.videoList = videos;
            state.videoListType = 'collection';
        } else if (videos.length === 1) {
            state.videoList = videos;
            state.videoListType = 'single';
        } else {
            state.videoList = [];
            state.videoListType = 'single';
        }
    }

    function init() {
        state.currentVideo = getCurrentVideoInfo();
        initVideoList();
        injectStyles();
        createFloatButton();
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
:root {
    --primary: #a18276;
    --primary-dark: #8a6f64;
    --primary-light: #b89a8f;
    --accent: #f4b886;
    --bg-primary: #fefdfb;
    --bg-secondary: #fcdfa6;
    --bg-surface: #f4b886;
    --bg-white: #ffffff;
    --bg-transparent: rgba(255, 255, 255, 0.02);
    --bg-hover: rgba(161, 130, 118, 0.1);
    --bg-selected: rgba(161, 130, 118, 0.15);
    --bg-selected-hover: rgba(161, 130, 118, 0.2);
    --bg-highlight: rgba(244, 184, 134, 0.3);
    --text-primary: #5c4a42;
    --text-secondary: #8a7268;
    --text-muted: #a89a90;
    --text-white: #ffffff;
    --border: rgba(92, 74, 66, 0.12);
    --border-hover: rgba(92, 74, 66, 0.2);
    --border-light: rgba(255, 255, 255, 0.15);
    --success: #7a9e7e;
    --error: #c97b7b;
    --warning: #e6a75c;
    --info: #a18276;
    --scrollbar-track-surface: rgba(161, 130, 118, 0.08);
    --scrollbar-thumb-surface: rgba(161, 130, 118, 0.4);
    --scrollbar-thumb-surface-hover: rgba(161, 130, 118, 0.6);
    --shadow-primary: rgba(161, 130, 118, 0.35);
    --shadow-primary-hover: rgba(161, 130, 118, 0.45);
    --shadow-primary-active: rgba(161, 130, 118, 0.3);
    --shadow-modal: rgba(0, 0, 0, 0.15);
    --shadow-toast: rgba(0, 0, 0, 0.3);
    --shadow-dropdown: rgba(161, 130, 118, 0.15);
    --icon-bg: rgba(59, 130, 246, 0.1);
    --focus-ring: rgba(161, 130, 118, 0.2);
    --btn-close-bg: rgba(255, 255, 255, 0.15);
    --btn-close-hover: rgba(255, 255, 255, 0.25);
    --btn-small-hover: rgba(255, 255, 255, 0.05);
    --btn-small-active: rgba(255, 255, 255, 0.08);
}

/* 通用基础样式 */
* { box-sizing: border-box; }
.base-transition { transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
.base-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-surface); }
.base-input {
    width: 100%; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px;
    font-size: 14px; background: var(--bg-surface); color: var(--text-primary);
    font-family: inherit; outline: none;
}
.base-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--focus-ring); background: var(--bg-white); }
.base-btn {
    padding: 14px 32px; border: none; border-radius: 16px; font-size: 15px; font-weight: 600;
    cursor: pointer; font-family: inherit; display: inline-flex; align-items: center;
    justify-content: center; gap: 10px; min-width: 120px;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.base-btn:hover {
    transform: translateY(-2px);
}
.base-btn:active {
    transform: translateY(0);
}
.base-btn-small {
    padding: 12px 20px; border: none; border-radius: 12px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; background: var(--bg-surface); color: var(--text-primary);
    border: 1px solid var(--border);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.base-btn-small:hover {
    background: var(--btn-small-hover);
    border-color: var(--border-hover);
    transform: translateY(-2px);
}
.base-btn-small:active {
    background: var(--btn-small-active);
    transform: translateY(0);
}

/* 统一滚动条样式 */
.subtitle-content, .checkbox-list, .format-list, .custom-select-dropdown, .settings-modal .modal-body {
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb-surface) var(--scrollbar-track-surface);
}
.subtitle-content::-webkit-scrollbar,
.checkbox-list::-webkit-scrollbar,
.format-list::-webkit-scrollbar,
.custom-select-dropdown::-webkit-scrollbar,
.settings-modal .modal-body::-webkit-scrollbar {
    width: 6px;
    display: block;
}
.subtitle-content::-webkit-scrollbar-track,
.checkbox-list::-webkit-scrollbar-track,
.format-list::-webkit-scrollbar-track,
.custom-select-dropdown::-webkit-scrollbar-track,
.settings-modal .modal-body::-webkit-scrollbar-track {
    background: var(--scrollbar-track-surface);
    border-radius: 3px;
}
.subtitle-content::-webkit-scrollbar-thumb,
.checkbox-list::-webkit-scrollbar-thumb,
.format-list::-webkit-scrollbar-thumb,
.custom-select-dropdown::-webkit-scrollbar-thumb,
.settings-modal .modal-body::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb-surface);
    border-radius: 3px;
}
.subtitle-content::-webkit-scrollbar-thumb:hover,
.checkbox-list::-webkit-scrollbar-thumb:hover,
.format-list::-webkit-scrollbar-thumb:hover,
.custom-select-dropdown::-webkit-scrollbar-thumb:hover,
.settings-modal .modal-body::-webkit-scrollbar-thumb:hover {
    background: var(--scrollbar-thumb-surface-hover);
}

/* 动画 */
@keyframes slideDown { from { opacity: 0; transform: translateX(-50%) translateY(-20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
@keyframes slideUp { from { opacity: 1; transform: translateX(-50%) translateY(0); } to { opacity: 0; transform: translateX(-50%) translateY(-20px); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

/* 全局字体 */
.bili-transcript-modal, .bili-transcript-toast, .bili-transcript-btn {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* 悬浮按钮 */
.bili-transcript-btn {
    position: fixed; right: 24px; bottom: 24px;
    width: 52px; height: 52px; border-radius: 50%;
    background: var(--primary);
    color: var(--text-white); border: none;
    box-shadow: 0 6px 20px var(--shadow-primary), 0 0 0 1px var(--border-light) inset;
    font-size: 20px; cursor: pointer; z-index: 10000;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex; align-items: center; justify-content: center;
}
.bili-transcript-btn:hover {
    transform: scale(1.1) translateY(-2px);
    box-shadow: 0 10px 30px var(--shadow-primary-hover), 0 0 0 1px rgba(255,255,255,0.2) inset;
}

/* Toast提示 */
.bili-transcript-toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    padding: 12px 20px; border-radius: 8px; box-shadow: 0 8px 24px var(--shadow-toast);
    z-index: 10006; display: flex; align-items: center; gap: 10px; font-size: 14px;
    color: var(--text-white); animation: slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.bili-transcript-toast-success { background: var(--success); }
.bili-transcript-toast-error { background: var(--error); }
.bili-transcript-toast-warning { background: var(--warning); }
.bili-transcript-toast-info { background: var(--info); }
.toast-icon { flex-shrink: 0; }
.toast-message { font-size: 14px; font-weight: 500; }

/* 模态框通用 */
.bili-transcript-modal {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    z-index: 10002; display: flex; align-items: center; justify-content: center;
    opacity: 1; transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    backdrop-filter: blur(4px);
}
.modal-overlay {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    background: transparent;
}
.modal-content {
    position: relative; width: 92%; max-width: 640px; max-height: 88vh;
    background: var(--bg-primary);
    border-radius: 14px; overflow: hidden;
    box-shadow: 0 12px 40px var(--shadow-modal), 0 0 0 1px var(--border);
    display: flex; flex-direction: column;
}
.modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 22px;
    background: var(--primary);
    color: var(--text-white);
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-light);
}
.modal-header h2 {
    margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3;
    display: flex; align-items: center; gap: 10px;
}
.modal-icon { flex-shrink: 0; }
.close-btn {
    width: 34px; height: 34px; border: none;
    background: var(--btn-close-bg);
    color: var(--text-white);
    border-radius: 12px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    padding: 0;
    font-size: 16px;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.close-btn:hover {
    background: var(--btn-close-hover);
    transform: scale(1.15);
}
.modal-body {
    padding: 24px;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
}
.modal-footer {
    display: flex; gap: 10px; justify-content: flex-end;
    padding: 16px 22px;
    border-top: 1px solid var(--border);
    background: var(--bg-transparent);
    flex-shrink: 0;
}
.btn-primary {
    padding: 10px 20px; border: none; border-radius: 12px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; display: inline-flex; align-items: center;
    justify-content: center; gap: 8px; min-width: 80px;
    background: var(--primary);
    color: var(--text-white);
    box-shadow: 0 4px 12px var(--shadow-primary);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px var(--shadow-primary-hover);
}
.btn-primary:active {
    transform: translateY(0);
    box-shadow: 0 3px 10px var(--shadow-primary-active);
}
.btn-secondary {
    padding: 10px 20px; border: 1px solid var(--border); border-radius: 12px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; display: inline-flex; align-items: center;
    justify-content: center; gap: 8px; min-width: 80px;
    background: var(--bg-surface);
    color: var(--text-primary);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn-secondary:hover {
    background: var(--bg-secondary);
    border-color: var(--border-hover);
    transform: translateY(-2px);
}
.btn-secondary:active {
    transform: translateY(0);
}
.btn-small {
    padding: 8px 16px; border: 1px solid var(--border); border-radius: 10px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit; display: inline-flex; align-items: center;
    justify-content: center; gap: 6px;
    background: var(--bg-surface);
    color: var(--text-primary);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn-small:hover {
    background: var(--bg-secondary);
    border-color: var(--border-hover);
    transform: translateY(-1px);
}
.btn-small:active {
    transform: translateY(0);
}

/* 视频信息 */
.video-info {
    padding: 18px 20px;
    background: var(--bg-surface);
    border-radius: 12px;
    border: 1px solid var(--border);
    flex-shrink: 0;
}
.info-row { display: flex; margin-bottom: 14px; align-items: flex-start; }
.info-row:last-child { margin-bottom: 0; }
.info-label {
    font-weight: 600;
    color: var(--text-secondary);
    width: 60px;
    flex-shrink: 0;
    font-size: 13px;
    letter-spacing: 0.5px;
}
.info-value {
    color: var(--text-primary);
    word-break: break-all;
    font-size: 14px;
    line-height: 1.65;
    font-weight: 400;
}

/* 自定义下拉框 */
.selector-container { flex-shrink: 0; }
.custom-select {
    position: relative;
    width: 100%;
    z-index: 10;
}
.custom-select-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 13px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.custom-select-trigger:hover {
    border-color: var(--border-hover);
    background: var(--bg-surface);
}
.custom-select-trigger:active { transform: scale(0.98); }
.custom-select-value { flex: 1; text-align: left; margin: 0; }
.custom-select-icon-wrapper {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin-left: 12px;
    color: var(--text-secondary);
    transition: color 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.custom-select-trigger:hover .custom-select-icon-wrapper,
.custom-select.active .custom-select-icon-wrapper {
    color: var(--text-primary);
}
.custom-select-icon-wrapper svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.custom-select-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 24px var(--shadow-dropdown);
    opacity: 0;
    visibility: hidden;
    transform: translateY(-8px);
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 100;
    max-height: 200px;
    overflow-y: auto;
}
.custom-select-dropdown.active {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
}
.custom-select-option {
    padding: 11px 16px;
    font-size: 14px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}
.custom-select-option:hover { background: var(--bg-hover); }
.custom-select-option.disabled {
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.6;
}
.custom-select-option.disabled:hover { background: none; }

/* 原生下拉框 */
.video-select {
    width: 100%; padding: 13px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    appearance: none;
    position: relative;
}
.video-select:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--focus-ring);
    background: var(--bg-white);
}
.video-select:hover {
    border-color: var(--border-hover);
    background: var(--bg-white);
}

/* 搜索框 */
.search-container { flex-shrink: 0; }
.search-input-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-surface);
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.search-input-wrapper:focus-within {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--focus-ring);
    background: var(--bg-white);
}
.search-icon { color: var(--text-secondary); flex-shrink: 0; }
.search-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 14px;
    color: var(--text-primary);
    font-family: inherit;
    outline: none;
}
.search-input::placeholder { color: var(--text-muted); }
.search-nav {
    display: flex;
    align-items: center;
    gap: 4px;
}
.search-nav-btn {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex;
    align-items: center;
    justify-content: center;
}
.search-nav-btn:hover {
    background: var(--btn-small-hover);
    color: var(--text-primary);
    transform: scale(1.1);
}
.search-status {
    font-size: 12px;
    color: var(--text-muted);
    min-width: 40px;
    text-align: center;
}
.highlight {
    background: var(--bg-highlight);
    padding: 0 2px;
    border-radius: 2px;
    font-weight: 500;
}
.search-match { background: var(--bg-selected); }
.subtitle-item.search-selected {
    background: var(--bg-selected-hover);
    border-left: 3px solid var(--primary);
}

/* 字幕内容 */
.subtitle-content-wrapper {
    flex: 0 1 420px;
    min-height: 180px;
    max-height: 420px;
}
.subtitle-content {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    background: var(--bg-primary);
}
.loading {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
}
.loading-spinner { animation: spin 1.5s linear infinite; }
.loading-path { animation: pulse 1.5s ease-in-out infinite; }
.no-subtitles {
    text-align: center;
    padding: 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
}
.no-subtitles-icon {
    width: 64px;
    height: 64px;
    margin-bottom: 20px;
    background: var(--icon-bg);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
}
.no-subtitles h3 {
    margin: 0 0 10px 0;
    color: var(--text-primary);
    font-size: 17px;
    font-weight: 600;
}
.no-subtitles p {
    margin: 0 0 20px 0;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.5;
}
.no-subtitles-tips {
    list-style: none;
    padding: 0;
    margin: 0;
    text-align: left;
}
.no-subtitles-tips li {
    margin-bottom: 8px;
    font-size: 13px;
    color: var(--text-muted);
    padding-left: 20px;
    position: relative;
}
.no-subtitles-tips li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 6px;
    width: 4px;
    height: 4px;
    background: var(--primary);
    border-radius: 50%;
}
.subtitle-item {
    display: flex; gap: 20px; padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    border-radius: 8px;
    margin: 2px 0;
}
.subtitle-item:last-child { border-bottom: none; }
.subtitle-item:hover {
    background: var(--bg-hover);
    transform: translateX(4px);
}
.subtitle-time {
    color: var(--primary);
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
    font-size: 12px;
    font-weight: 500;
    flex-shrink: 0;
    width: 90px;
    text-align: right;
    letter-spacing: 0.3px;
}
.subtitle-text {
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.6;
    flex: 1;
    padding-left: 12px;
    border-left: 1px solid var(--border);
}

/* 批量下载 */
.batch-modal { max-width: 680px; }
.batch-section { margin-bottom: 24px; }
.batch-section:last-child { margin-bottom: 0; }
.batch-section h3 {
    margin: 0 0 14px 0;
    font-size: 14px;
    color: var(--text-primary);
    font-weight: 600;
}
.batch-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px;
}
.batch-header h3 { margin: 0; font-size: 15px; }
.batch-actions { display: flex; gap: 8px; }
.checkbox-list {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
    background: var(--bg-secondary);
}
.checkbox-item {
    display: flex;
    align-items: center;
    padding: 11px 14px;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    gap: 11px;
}
.checkbox-item:hover { background: var(--bg-hover); }
.checkbox-item:has(input:checked) { background: var(--bg-selected); }
.checkbox-item:has(input:checked):hover { background: var(--bg-selected-hover); }
.checkbox-item input {
    width: 16px;
    height: 16px;
    accent-color: var(--primary);
    cursor: pointer;
    flex-shrink: 0;
}
.checkbox-item span {
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
    font-weight: 400;
}

/* 下载确认弹窗 */
.download-modal { max-width: 500px; }
.download-section {
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.download-label {
    font-size: 13px;
    color: var(--text-secondary);
    font-weight: 500;
}
.download-input {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: inherit;
    outline: none;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.download-input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--focus-ring);
    background: var(--bg-white);
}
.download-format-display {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-weight: 500;
}
.download-format-display .format-hint {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: normal;
}
.download-methods {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.download-method-label {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    background: var(--bg-surface);
    border: 1px solid var(--border);
}
.download-method-label:hover {
    background: var(--btn-small-hover);
    border-color: var(--border-hover);
}
.download-method-label input {
    width: 16px;
    height: 16px;
    accent-color: var(--primary);
    cursor: pointer;
}
.download-method-label span {
    color: var(--text-primary);
    font-size: 13px;
}
.download-method-label:has(input:checked) {
    background: var(--primary);
    border-color: var(--primary);
}
.download-method-label:has(input:checked) span {
    color: var(--text-white);
    font-weight: 600;
}

/* 设置弹窗 */
.settings-modal {
    max-width: 520px;
    max-height: 80vh;
    overflow-y: auto !important;
    overflow-x: hidden;
}
.settings-modal .modal-body {
    max-height: calc(80vh - 140px);
    overflow-y: auto;
}
.settings-section { margin-bottom: 20px; }
.settings-section:last-child { margin-bottom: 0; }
.settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
}
.settings-section h3 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: var(--text-primary);
    font-weight: 600;
}
.settings-header h3 { margin: 0; }
.settings-checkbox {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    padding: 10px 12px;
    border-radius: 8px;
    transition: background 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.settings-checkbox:hover { background: var(--bg-hover); }
.settings-checkbox input {
    width: 17px;
    height: 17px;
    accent-color: var(--primary);
    cursor: pointer;
}
.settings-checkbox span {
    color: var(--text-primary);
    font-size: 14px;
}
.format-list {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
    background: var(--bg-secondary);
    max-height: 200px;
    overflow-y: auto;
}
.format-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.format-item:hover { background: var(--bg-hover); }
.format-item.selected {
    background: var(--bg-selected);
    border: 1px solid var(--primary);
    margin: -1px;
}
.format-name {
    font-size: 14px;
    color: var(--text-primary);
}
.remove-ext-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    background: var(--error);
    color: white;
    opacity: 0.9;
}
.remove-ext-btn:hover {
    opacity: 1;
    transform: scale(1.1);
    box-shadow: 0 4px 12px rgba(201, 123, 123, 0.4);
}

/* 自定义扩展名弹窗 */
.custom-ext-modal { max-width: 400px; }
.custom-ext-section {
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.custom-ext-label {
    font-size: 13px;
    color: var(--text-secondary);
    font-weight: 500;
}
.mime-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-radius: 6px;
}
.custom-ext-input {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: inherit;
    outline: none;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.custom-ext-input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--focus-ring);
    background: var(--bg-white);
}
.custom-ext-input::placeholder { color: var(--text-muted); }

/* 响应式 */
@media (max-width: 480px) {
    .modal-footer { flex-direction: column; }
    .btn-primary, .btn-secondary { width: 100%; justify-content: center; }
    .modal-body { padding: 16px; }
    .modal-header { padding: 14px 16px; }
    .search-nav { display: none; }
}
        `;
        document.head.appendChild(style);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();