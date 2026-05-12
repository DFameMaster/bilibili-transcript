# B站字幕提取器 / Bilibili Subtitle Extractor

[中文](#中文) | [English](#english)

---

## 中文

### 简介

B站字幕提取器是一款高效的油猴脚本，帮助用户从B站（Bilibili）视频页面快速提取字幕内容。支持单个视频、多分P视频以及合集视频的字幕提取，可导出为10种常见格式，并提供强大的字幕搜索定位功能。

### 功能特点

#### 核心功能

- **字幕提取**：自动检测并提取B站视频的字幕内容
- **多格式导出**：支持 TXT、MD、CSV、XML、HTML、SRT、VTT、ASS、LRC、JSON 等10种格式
- **分P支持**：可单独提取某个分P或批量提取整个系列
- **合集支持**：一次性提取合集中所有视频的字幕
- **字幕搜索**：支持关键词搜索，高亮显示匹配结果，快速定位到目标位置
- **批量下载**：可选择多个视频同时下载字幕

#### 自定义选项

- **自定义扩展名**：可根据需要添加自定义文件扩展名和MIME类型
- **灵活的文件名设置**：
  - 可选择是否包含BV号
  - 可选择是否包含时间戳
  - 可选择是否包含视频时长
- **灵活的字幕导出设置**：
  - 可选择是否包含字幕时间轴
- **下载方式选择**：支持直接下载或新标签页打开

### 支持的导出格式

| 格式 | 说明         | 适用场景           |
| ---- | ------------ | ------------------ |
| TXT  | 纯文本       | 最广泛的兼容性     |
| MD   | Markdown     | 笔记整理、文档编写 |
| CSV  | 表格格式     | 数据分析、表格处理 |
| XML  | XML格式      | 专业技术处理       |
| HTML | 网页格式     | 浏览器直接查看     |
| SRT  | 字幕标准格式 | 视频压制、播放器   |
| VTT  | WebVTT格式   | 网页嵌入字幕       |
| ASS  | ASS字幕格式  | 高质量视频压制     |
| LRC  | 歌词同步格式 | 音乐播放、歌词展示 |
| JSON | JSON数据格式 | 程序处理、数据交换 |

### 安装要求

- **浏览器**：支持用户脚本的浏览器（如 Chrome、Firefox、Edge 等）
- **脚本管理器**：需要安装 Tampermonkey、Violentmonkey 或 Greasemonkey 等脚本管理器
- **网络环境**：需要能够正常访问B站

### 安装步骤

#### 方法一：ScriptCat（推荐）

直接访问 ScriptCat 脚本市场安装：

- [B站字幕提取器 - ScriptCat](https://scriptcat.org/zh-CN/script-show-page/6245)

#### 方法二：手动安装

1. 安装适合你浏览器的脚本管理器扩展
   - [Tampermonkey (推荐)](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)
   - [Greasemonkey](http://www.greasespot.net/)

2. 点击安装脚本：[bilibili-transcript.user.js](bilibili-transcript.user.js)

3. 访问B站视频页面，自动生效

### 使用方法

1. 打开任意B站视频页面
2. 页面右下角会出现一个悬浮按钮（褐色主题）
3. 点击按钮打开字幕提取面板
4. 选择字幕来源（当前视频/分P列表/合集）
5. 选择要提取的字幕
6. 设置导出格式和文件名选项
7. 点击下载或复制

### 界面预览

- **悬浮按钮**：页面右下角的圆形按钮，点击打开主面板
- **字幕面板**：显示视频信息、字幕列表、搜索框和操作按钮
- **设置面板**：可自定义文件名格式、下载方式等选项
- **批量下载面板**：可选择多个视频进行批量下载

### 注意事项

- 本脚本仅用于个人学习研究，请勿用于商业用途
- 尊重字幕创作者的劳动成果，合理使用
- 部分视频可能没有字幕或字幕不可用
- 使用过程中请确保网络连接正常

### 常见问题

**Q: 为什么有些视频没有字幕？**
A: 并非所有B站视频都有字幕，通常只有用户主动上传字幕的视频才会有。

**Q: 如何提取合集的所有字幕？**
A: 在字幕面板中选择"合集"选项，即可看到合集中的所有视频列表，批量选择后下载。

**Q: 导出的文件乱码怎么办？**
A: 尝试使用不同的格式导出，TXT格式兼容性最好。

### 更新日志

#### v1.0.0

- 初始版本发布
- 支持10种格式导出
- 实现字幕搜索定位功能
- 支持批量下载

### 联系方式

- 作者博客：[https://blog.qitongtingyu.online/](https://blog.qitongtingyu.online/)
- 问题反馈：欢迎通过博客留言反馈问题

### 许可证

本项目采用 MIT 许可证开源。

---

## English

### Overview

Bilibili Subtitle Extractor is a efficient userscript that helps you quickly extract subtitles from Bilibili videos. It supports single videos, multi-part videos, and entire series, with export capability to 10 popular formats and powerful subtitle search functionality.

### Features

#### Core Features

- **Subtitle Extraction**: Automatically detects and extracts subtitles from Bilibili videos
- **Multi-format Export**: Supports 10 formats including TXT, MD, CSV, XML, HTML, SRT, VTT, ASS, LRC, and JSON
- **Multi-part Support**: Extract individual parts or batch download an entire series
- **Series Support**: Extract subtitles from all videos in a series at once
- **Subtitle Search**: Search by keywords with highlight matching and quick navigation
- **Batch Download**: Select multiple videos for simultaneous subtitle download

#### Customization Options

- **Custom Extensions**: Add custom file extensions and MIME types as needed
- **Flexible Filename Settings**:
  - Option to include/exclude BV number
  - Option to include/exclude timestamp
  - Option to include/exclude video duration
  - Option to include/exclude subtitle timestamps
- **Download Method**: Direct download or open in new tab

### Supported Export Formats

| Format | Description         | Use Case                          |
| ------ | ------------------- | --------------------------------- |
| TXT    | Plain Text          | Maximum compatibility             |
| MD     | Markdown            | Note-taking, documentation        |
| CSV    | Spreadsheet Format  | Data analysis                     |
| XML    | XML Format          | Technical processing              |
| HTML   | Web Page Format     | Browser viewing                   |
| SRT    | Subtitle Standard   | Video encoding, players           |
| VTT    | WebVTT Format       | Web subtitle embedding            |
| ASS    | ASS Subtitle Format | High-quality video encoding       |
| LRC    | Lyrics Sync Format  | Music players, lyrics display     |
| JSON   | JSON Data Format    | Program processing, data exchange |

### Installation Requirements

- **Browser**: Any browser supporting userscripts (Chrome, Firefox, Edge, etc.)
- **Script Manager**: Tampermonkey, Violentmonkey, or Greasemonkey extension
- **Network**: Must have access to Bilibili

### Installation Steps

#### Method 1: ScriptCat (Recommended)

Install directly from ScriptCat script marketplace:

- [Bilibili Subtitle Extractor - ScriptCat](https://scriptcat.org/zh-CN/script-show-page/6245)

#### Method 2: Manual Installation

1. Install a script manager extension for your browser
   - [Tampermonkey (Recommended)](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)
   - [Greasemonkey](http://www.greasespot.net/)

2. Click to install: [bilibili-transcript.user.js](bilibili-transcript.user.js)

3. Visit any Bilibili video page - the script activates automatically

### Usage Guide

1. Open any Bilibili video page
2. A floating button (brown theme) appears in the bottom-right corner
3. Click the button to open the subtitle extraction panel
4. Select subtitle source (current video / part list / series)
5. Choose the subtitle to extract
6. Configure export format and filename options
7. Click download or copy

### Interface Preview

- **Floating Button**: Circular button at bottom-right, opens main panel
- **Subtitle Panel**: Shows video info, subtitle list, search box, and action buttons
- **Settings Panel**: Customize filename format, download method, etc.
- **Batch Download Panel**: Select multiple videos for batch downloading

### Notes

- This script is for personal learning and research only, please do not use for commercial purposes
- Respect subtitle creators' work and use responsibly
- Some videos may not have subtitles or subtitles may be unavailable
- Ensure stable network connection while using

### FAQ

**Q: Why do some videos have no subtitles?**
A: Not all Bilibili videos have subtitles - typically only videos with user-uploaded subtitles will have them available.

**Q: How to extract all subtitles from a series?**
A: Select the "Series" option in the subtitle panel to see all videos in the series, then batch select and download.

**Q: Exported files appear garbled, what to do?**
A: Try exporting in different formats - TXT has the best compatibility.

### Changelog

#### v1.0.0

- Initial release
- 10 format export support
- Subtitle search and navigation
- Batch download functionality

### Contact

- Author Blog: [https://blog.qitongtingyu.online/](https://blog.qitongtingyu.online/)
- Feedback: Welcome to leave messages on the blog for issues

### License

This project is open source under the MIT License.
