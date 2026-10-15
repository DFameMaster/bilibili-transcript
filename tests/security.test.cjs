const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// 不启动界面、不访问网络，直接测试发布脚本中的真实函数。
function loadScript() {
    const container = { innerHTML: '' };
    const requests = [];
    const document = {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) { return id === 'subtitle-content' ? container : null; },
        querySelectorAll() { return []; },
        get cookie() { throw new Error('不应手动读取页面 Cookie'); }
    };
    const sandbox = {
        document, URL, console, setTimeout, clearTimeout,
        navigator: { userAgent: 'security-test' },
        GM_xmlhttpRequest(options) {
            requests.push(options);
            options.onload({ responseText: JSON.stringify({ code: 0, body: [] }) });
        }
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-transcript.user.js'), 'utf8');
    const end = source.lastIndexOf('})();');
    assert.ok(end > 0);
    vm.runInNewContext(source.slice(0, end) + `
        globalThis.subject = {
            escapeCSV, convertToCSV, convertToTXT, convertToHTML,
            highlightSubtitleContent, renderSubtitlesWithHighlight,
            request, getSubtitleContent, state
        };
    ` + source.slice(end), sandbox);
    return { subject: sandbox.subject, container, requests };
}

test('搜索整条字幕时只保留受控高亮标签，恶意 HTML 仍为文字', () => {
    const { subject, container } = loadScript();
    subject.state.subtitleDetails = [{ from: 0, to: 1, content: '<img src=x onerror="alert(1)">Hello' }];
    subject.renderSubtitlesWithHighlight('hello');
    assert.ok(!container.innerHTML.includes('<img'));
    assert.ok(container.innerHTML.includes('&lt;img'));
    assert.ok(container.innerHTML.includes('<span class="highlight">Hello</span>'));
});

test('搜索词本身包含 HTML、正则符号时仍按字面匹配', () => {
    const { subject } = loadScript();
    assert.equal(subject.highlightSubtitleContent('a+b [x] a+b', 'a+b'),
        '<span class="highlight">a+b</span> [x] <span class="highlight">a+b</span>');
    assert.equal(subject.highlightSubtitleContent('<svg/onload=1>', '<svg'),
        '<span class="highlight">&lt;svg</span>&#x2F;onload=1&gt;');
    assert.equal(subject.highlightSubtitleContent('中文 & < >', ''), '中文 &amp; &lt; &gt;');
});

test('搜索结果的时间属性不能注入新属性', () => {
    const { subject, container } = loadScript();
    subject.state.subtitleDetails = [{ from: '0" onmouseover="alert(1)', content: 'hello' }];
    subject.renderSubtitlesWithHighlight('hello');
    assert.ok(container.innerHTML.includes('data-time="0"'));
    assert.ok(!container.innerHTML.includes('onmouseover'));
});

test('HTML 导出转义脚本和事件标签，保留换行及可选时间轴', () => {
    const { subject } = loadScript();
    const content = [{ from: 0, content: '<script>alert(1)</script>' }, { from: 1, content: '你好 & 世界' }];
    const html = subject.convertToHTML(content, false);
    assert.ok(!html.includes('<script>'));
    assert.equal(html, '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;<br>\n你好 &amp; 世界');
    assert.ok(subject.convertToHTML(content, true).startsWith('00:00:00,000 '));
});

test('CSV 中公式、前导空白及控制字符不会直接作为公式起始', () => {
    const { subject } = loadScript();
    for (const value of ['=1+1', '+1', '-1', '@SUM(A1)', '  =1', '\uFEFF=1', '\t=1', '\r=1', '\n=1']) {
        assert.match(subject.escapeCSV(value), /^"?'/);
    }
    assert.equal(subject.escapeCSV('中文'), '中文');
    assert.equal(subject.escapeCSV('a,"b"\r\nc'), '"a,""b""\r\nc"');
    assert.ok(subject.convertToCSV([{ from: 0, to: 1, content: '=1+1' }]).includes(",'=1+1\n"));
});

test('纯文字导出不增加时间或改变原字幕内容', () => {
    const { subject } = loadScript();
    assert.equal(subject.convertToTXT([{ from: 0, content: '第一行' }, { from: 1, content: '<文字>&' }]), '第一行\n<文字>&');
});

test('B 站 API 保留正常登录态，但不读取或手动转发 Cookie', async () => {
    const { subject, requests } = loadScript();
    await subject.request('https://api.bilibili.com/x/web-interface/view?bvid=BVtest');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].anonymous, false);
    assert.ok(!Object.keys(requests[0].headers).some(key => key.toLowerCase() === 'cookie'));
});

test('真实字幕下载路径使用匿名 CDN 请求，兼容协议相对 URL', async () => {
    const { subject, requests } = loadScript();
    await subject.getSubtitleContent('//aisubtitle.hdslb.com/bfs/test.json', 'BVtest', 1, 1);
    assert.equal(requests[0].url, 'https://aisubtitle.hdslb.com/bfs/test.json');
    assert.equal(requests[0].anonymous, true);
    assert.ok(!Object.keys(requests[0].headers).some(key => key.toLowerCase() === 'cookie'));
});

test('拒绝非 HTTPS、伪装域名、URL 凭据及非标准端口，不发出请求', async () => {
    const { subject, requests } = loadScript();
    for (const url of [
        'http://aisubtitle.hdslb.com/test',
        'https://aisubtitle.hdslb.com.evil.example/test',
        'https://api.bilibili.com@evil.example/test',
        'https://user:pass@api.bilibili.com/test',
        'https://api.bilibili.com:8443/test',
        'javascript:alert(1)'
    ]) {
        await assert.rejects(subject.request(url), /不允许的请求地址/);
    }
    assert.equal(requests.length, 0);
});
