/**
 * FlClash 覆写脚本 —— 订阅结构重整 + 服务分流（单文件通用版）
 *
 * 用法：FlClash → 配置 → 覆写脚本 → 右上角 + → 粘贴本文件全部内容 → 保存，
 *       然后在订阅卡片上选择该覆写脚本。
 *
 * 运行时：FlClash 内置 QuickJS 沙箱，纯本地转换，无网络、无文件访问，
 *         main(config) 返回的对象会替换订阅配置（不改写订阅文件本身）。
 *
 * 做什么：
 *   1. 不动节点：订阅里的节点名称、顺序、字段原样保留，只做归类（伪节点不进分组，但仍留在 proxies 里）；
 *   2. 按名称识别地区，聚合成地区自动组（`香港-自动` / `日本-自动` …）与地区手动组，节点名本身不篡改；
 *   3. 重建分组：入口 / 自动（默认自动测速，可手动覆盖）/ 故障转移 / 直连 / 地区（自动+手动）/ 服务 / 广告拦截；
 *      分组规模由 GROUP_LAYOUT 控制（默认 compact：合并同类服务、去掉重复地区手动组与故障转移/拒绝组），
 *      每个分组附带 icon（FlClash 列表视图显示）；
 *      服务组与自动组都会挂上 provider 引用，因此仅 provider 订阅下也能在任意组内手动选节点；
 *      原本英文的 DIRECT 与 REJECT 统一映射为中文「直连」与「拒绝」策略组，界面告别冷冰冰的英文；
 *   4. 重建规则：所有判定来自 Loyalsoldier/clash-rules，手写规则只做补丁，命中顺序显式且无重复。
 *      路由模式由 ROUTING_MODE 控制，前七段两种模式共用：
 *      Tailscale → 本机/内网 → 补充直连（EXTRA_DIRECT_RULES）→ 服务放行（service.priority）
 *      → 统计上报残留 → 拒绝集（Reject）→ 服务规则/服务分类集；
 *      proxy-if-matched（默认，命中规则的才走代理，省代理流量）：后半段是
 *      补充代理（EXTRA_PROXY_RULES）→ 墙站表（GFW / GreatFire / 非中国 TLD / ProxyList）
 *      → 兜底直连；
 *      direct-if-matched（命中直连规则的才直连）：后半段换成
 *      私有域名（Private）/ 直连域名（Direct）/ 局域网段（LanCIDR）/ 国内 IP 段（CNCIDR）
 *      → .cn → GEOIP,CN → 兜底走代理。
 *      服务放行必须排在拒绝集之前：reject.txt 会把 Google 的 -pa 端点一起收走，
 *      典型症状是 ogads-pa.clients6.google.com 被判广告后 Gemini 直接不可用；
 *      服务规则（手写）排在服务分类集之前，谁更精确谁先命中；
 *      上游也没收录的站由 EXTRA_DIRECT_RULES（该直连）/ EXTRA_PROXY_RULES（该代理）显式兜住；
 *      Tailscale 支持两种接入方式（脚本顶部 TAILSCALE_MODE）：
 *      `direct` 本机已装官方客户端，网段与 ts.net 强制直连、MagicDNS 走 100.100.100.100；
 *      `outbound` 未装官方客户端（Android），注入 type: tailscale 出站节点，仅能主动访问 tailnet；
 *   5. 重建 DNS：默认国内 DoH，境外域名按服务走对应出口解析，
 *      避免原订阅「nameserver 指向代理组」造成的启动死锁；
 *   6. 订阅只有 proxy-providers（没有内联 proxies）时同样可用：
 *      分组改为 `use` 引用 provider，地区维度自动跳过。
 * 注意：本脚本整体替换 proxy-groups / rules / dns，原订阅里的自定义分组与规则
 *       会一并丢弃（它们引用的是旧组名，保留会导致 mihomo 拒绝加载）。
 */

// ─────────────────────────── 可调参数 ───────────────────────────

const TEST_URL = 'https://www.gstatic.com/generate_204';
const INTERVAL = 300;
const TOLERANCE = 50;
const LAZY = true;

const CN_DNS = ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'];
const FOREIGN_DNS = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];

const GROUP = {
  entry: '节点选择',
  auto: '自动选择',
  autoTest: '自动测速',
  fallback: '故障转移',
  direct: '直连',
  reject: '拒绝',
  adblock: '广告拦截',
};

const OVERSEAS_DNS_GROUP = GROUP.auto; // 境外域名默认由该组出口解析

// 分组图标：FlClash 的列表视图读取 mihomo 的 group.icon（URL）。
// 换成自建图床时只改 ICON_BASE；地区图标由 REGIONS[].icon 指定文件名。
const ICON_BASE = 'https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color';
const ICON = {
  entry: `${ICON_BASE}/Proxy.png`,
  auto: `${ICON_BASE}/Auto.png`,
  autoTest: `${ICON_BASE}/Speedtest.png`,
  fallback: `${ICON_BASE}/Round_Robin.png`,
  direct: `${ICON_BASE}/Direct.png`,
  reject: `${ICON_BASE}/Reject.png`,
  adblock: `${ICON_BASE}/Advertising.png`,
  tailscale: `${ICON_BASE}/Server.png`,
  ai: `${ICON_BASE}/AI.png`,
  copilot: `${ICON_BASE}/Copilot.png`,
  youtube: `${ICON_BASE}/YouTube.png`,
  google: `${ICON_BASE}/Google.png`,
  telegram: `${ICON_BASE}/Telegram.png`,
  social: `${ICON_BASE}/Telegram.png`,
  media: `${ICON_BASE}/Media.png`,
  streaming: `${ICON_BASE}/Streaming.png`,
  system: `${ICON_BASE}/Microsoft.png`,
  apple: `${ICON_BASE}/Apple.png`,
  developer: `${ICON_BASE}/GitHub.png`,
};

const iconUrl = (name) => `${ICON_BASE}/${name}.png`;

// ─────────────────────────── 节点识别 ───────────────────────────

// 官网、链接、推广等纯广告节点：彻底剔除
const JUNK_NODE =
  /官网|网址|主页|https?:\/\/|t\.me|telegram|群组|客服|发布页|最新域名|防止迷路|倍率|请勿测速|重置倍率/i;

// 包含套餐流量或到期时间特征的信息节点：识别并提取
const INFO_NODE =
  /剩余流量|可用流量|剩余套餐|已用流量|总流量|套餐到期|到期时间|过期时间|重置日|距离下次重置|到期/i;

// 用于 provider 节点的排除正则（provider 节点无法由 JS 提取修改，直接排除免测速污染）
const NOTICE_PATTERN =
  '剩余流量|套餐到期|已用流量|到期时间|重置|官网|订阅|客服|群组|公告|邀请|机场|倍率|https?://';

const REGIONS = [
  { key: 'HK', name: '香港', flag: '🇭🇰', icon: 'HK', re: /(^|[-_ ])(HK|HKG|Hong Kong)([-_ ]|$)|香港|深港|沪港|京港/i },
  { key: 'TW', name: '台湾', flag: '🇹🇼', icon: 'TW', re: /(^|[-_ ])(TW|TWN|Taiwan)([-_ ]|$)|台湾|台北|新北|彰化/i },
  { key: 'JP', name: '日本', flag: '🇯🇵', icon: 'JP', re: /(^|[-_ ])(JP|JPN|JPSB|Japan)([-_ ]|$)|日本|东京|大阪|埼玉/i },
  { key: 'SG', name: '新加坡', flag: '🇸🇬', icon: 'SG', re: /(^|[-_ ])(SG|SGP|Singapore)([-_ ]|$)|新加坡|狮城/i },
  { key: 'US', name: '美国', flag: '🇺🇸', icon: 'US', re: /(^|[-_ ])(US|USA|United States)([-_ ]|$)|美国|洛杉矶|硅谷|圣何塞|西雅图|芝加哥|达拉斯|纽约/i },
  { key: 'KR', name: '韩国', flag: '🇰🇷', icon: 'KR', re: /(^|[-_ ])(KR|KOR|Korea)([-_ ]|$)|韩国|首尔|春川/i },
  { key: 'GB', name: '英国', flag: '🇬🇧', icon: 'UK', re: /(^|[-_ ])(UK|GBR|Britain)([-_ ]|$)|英国|伦敦/i },
  { key: 'DE', name: '德国', flag: '🇩🇪', icon: 'DE', re: /(^|[-_ ])(DE|GER|Germany)([-_ ]|$)|德国|法兰克福/i },
  { key: 'FR', name: '法国', flag: '🇫🇷', icon: 'FR', re: /(^|[-_ ])(FR|FRA|France)([-_ ]|$)|法国|巴黎/i },
  { key: 'NL', name: '荷兰', flag: '🇳🇱', icon: 'Area', re: /(^|[-_ ])(NL|NLD|Netherlands)([-_ ]|$)|荷兰|阿姆斯特丹/i },
  { key: 'CA', name: '加拿大', flag: '🇨🇦', icon: 'CA', re: /(^|[-_ ])(CA|CAN|Canada)([-_ ]|$)|加拿大|多伦多|温哥华|蒙特利尔/i },
  { key: 'AU', name: '澳大利亚', flag: '🇦🇺', icon: 'AU', re: /(^|[-_ ])(AU|AUS|Australia)([-_ ]|$)|澳大利亚|澳洲|悉尼|墨尔本/i },
];

const OTHER_REGION = { key: 'XX', name: '其他', flag: '🏳️', icon: 'Area' };

// ─────────────────────────── 规则数据 ───────────────────────────

const OPENCODE_RULES = ['DOMAIN-SUFFIX,opencode.ai', 'DOMAIN-KEYWORD,opencode'];

const CLAUDE_RULES = [
  'DOMAIN,http-intake.logs.us5.datadoghq.com',
  'DOMAIN,browser-intake-us5.datadoghq.com',
  'DOMAIN-SUFFIX,claude.ai',
  'DOMAIN-SUFFIX,claude.com',
  'DOMAIN-SUFFIX,anthropic.com',
  'DOMAIN-SUFFIX,claudeusercontent.com',
  'DOMAIN-SUFFIX,claudemcpcontent.com',
];

const AI_RULES = [
  'DOMAIN,chat.openai.com.cdn.cloudflare.net',
  'DOMAIN,openai-api.arkoselabs.com',
  'DOMAIN,openaiapi-site.azureedge.net',
  'DOMAIN,openaicom-api-bdcpf8c6d2e9atf6.z01.azurefd.net',
  'DOMAIN,openaicomproductionae4b.blob.core.windows.net',
  'DOMAIN,production-openaicom-storage.azureedge.net',
  'DOMAIN,openaicom.imgix.net',
  'DOMAIN,o33249.ingest.sentry.io',
  'DOMAIN-SUFFIX,chatgpt.com',
  'DOMAIN-SUFFIX,openai.com',
  'DOMAIN-SUFFIX,oaistatic.com',
  'DOMAIN-SUFFIX,oaiusercontent.com',
  'DOMAIN-SUFFIX,chatgpt.livekit.cloud',
  'DOMAIN-SUFFIX,gemini.google.com',
  'DOMAIN-SUFFIX,aistudio.google.com',
  'DOMAIN-SUFFIX,ai.google.dev',
  'DOMAIN-SUFFIX,generativelanguage.googleapis.com',
  'DOMAIN-SUFFIX,notebooklm.google.com',
  'DOMAIN-SUFFIX,notebooklm.google',
  'DOMAIN-SUFFIX,jules.google.com',
  'DOMAIN-SUFFIX,geller-pa.googleapis.com',
  'DOMAIN-SUFFIX,aisandbox-pa.googleapis.com',
  'DOMAIN-SUFFIX,aida.googleapis.com',
  'DOMAIN-SUFFIX,bard.google.com',
  'DOMAIN-SUFFIX,makersuite.google.com',
  'DOMAIN-SUFFIX,deepmind.google',
  'DOMAIN-SUFFIX,perplexity.ai',
  'DOMAIN-SUFFIX,pplx.ai',
  'DOMAIN-SUFFIX,poe.com',
  'DOMAIN-SUFFIX,grok.com',
  'DOMAIN-SUFFIX,x.ai',
  'DOMAIN-SUFFIX,cohere.ai',
  'DOMAIN-SUFFIX,mistral.ai',
  'DOMAIN-SUFFIX,openrouter.ai',
  'DOMAIN-SUFFIX,midjourney.com',
  'DOMAIN-SUFFIX,elevenlabs.io',
  'DOMAIN-SUFFIX,assemblyai.com',
  'DOMAIN-SUFFIX,suno.com',
  'DOMAIN-SUFFIX,runwayml.com',
];

// 广告库误伤放行：这类端点被拒绝集判成广告后，整条业务链路直接断。
// ogads-pa.clients6.google.com 在 Loyalsoldier reject.txt 里（同上一个源），
// 命中即 REJECT，表现为 Gemini 会话 / 图片接口 403、页面一直转圈。
// 规则必须排在 RULE-SET,Reject 之前（由 service.priority 保证）。
const AI_ALLOW_RULES = [
  'DOMAIN,ogads-pa.clients6.google.com',
  'DOMAIN,ogads-pa.googleapis.com',
];

// 服务放行规则：命中即归属该服务组，且早于拒绝集与直连兜底。
const AI_PRIORITY_RULES = [...AI_ALLOW_RULES];

const COPILOT_RULES = [
  'DOMAIN,gateway.bingviz.microsoft.net',
  'DOMAIN,gateway.bingviz.microsoftapp.net',
  'DOMAIN-SUFFIX,copilot.microsoft.com',
  'DOMAIN-SUFFIX,bing.com',
  'DOMAIN-SUFFIX,bing.net',
  'DOMAIN-SUFFIX,bingapis.com',
  'DOMAIN-SUFFIX,copilot.cloud.microsoft',
  'DOMAIN-SUFFIX,copilotstudio.microsoft.com',
  'DOMAIN-SUFFIX,edgeservices.bing.com',
];

const GOOGLE_RULES = [
  'DOMAIN-SUFFIX,google.com',
  'DOMAIN-SUFFIX,googleapis.com',
  'DOMAIN-SUFFIX,googleapis.cn',
  'DOMAIN-SUFFIX,gstatic.com',
  'DOMAIN-SUFFIX,googleusercontent.com',
  'DOMAIN-SUFFIX,ggpht.com',
  'DOMAIN-SUFFIX,gvt1.com',
  'DOMAIN-SUFFIX,gvt2.com',
];

const YOUTUBE_RULES = [
  'DOMAIN-SUFFIX,youtube.com',
  'DOMAIN-SUFFIX,youtu.be',
  'DOMAIN-SUFFIX,ytimg.com',
  'DOMAIN-SUFFIX,googlevideo.com',
  'DOMAIN-SUFFIX,youtube-nocookie.com',
];

const TELEGRAM_RULES = [
  'DOMAIN-SUFFIX,telegram.org',
  'DOMAIN-SUFFIX,t.me',
  'DOMAIN-SUFFIX,tdesktop.com',
  'DOMAIN-SUFFIX,telegram.org.ru',
  'IP-CIDR,91.108.4.0/22,no-resolve',
  'IP-CIDR,91.108.8.0/22,no-resolve',
  'IP-CIDR,91.108.12.0/22,no-resolve',
  'IP-CIDR,91.108.16.0/22,no-resolve',
  'IP-CIDR,91.108.20.0/22,no-resolve',
  'IP-CIDR,91.108.56.0/22,no-resolve',
  'IP-CIDR,149.154.160.0/20,no-resolve',
];

const SOCIAL_RULES = [
  'DOMAIN-SUFFIX,x.com',
  'DOMAIN-SUFFIX,twitter.com',
  'DOMAIN-SUFFIX,twimg.com',
  'DOMAIN-SUFFIX,t.co',
  'DOMAIN-SUFFIX,facebook.com',
  'DOMAIN-SUFFIX,fbcdn.net',
  'DOMAIN-SUFFIX,instagram.com',
  'DOMAIN-SUFFIX,whatsapp.com',
  'DOMAIN-SUFFIX,whatsapp.net',
  'DOMAIN-SUFFIX,wikipedia.org',
  'DOMAIN-SUFFIX,wikimedia.org',
  'DOMAIN-SUFFIX,reddit.com',
  'DOMAIN-SUFFIX,redd.it',
  'DOMAIN-SUFFIX,discord.com',
  'DOMAIN-SUFFIX,discord.gg',
  'DOMAIN-SUFFIX,discordapp.com',
  'DOMAIN-SUFFIX,discordapp.net',
];

const MEDIA_RULES = [
  'DOMAIN-SUFFIX,netflix.com',
  'DOMAIN-SUFFIX,nflxvideo.net',
  'DOMAIN-SUFFIX,nflximg.net',
  'DOMAIN-SUFFIX,spotify.com',
  'DOMAIN-SUFFIX,scdn.co',
  'DOMAIN-SUFFIX,disneyplus.com',
  'DOMAIN-SUFFIX,hbomax.com',
  'DOMAIN-SUFFIX,primevideo.com',
  'DOMAIN-SUFFIX,twitch.tv',
  'DOMAIN-SUFFIX,ttvnw.net',
];

const MICROSOFT_RULES = [
  'DOMAIN-SUFFIX,microsoft.com',
  'DOMAIN-SUFFIX,microsoftonline.com',
  'DOMAIN-SUFFIX,office.com',
  'DOMAIN-SUFFIX,office365.com',
  'DOMAIN-SUFFIX,windows.com',
  'DOMAIN-SUFFIX,windowsupdate.com',
  'DOMAIN-SUFFIX,live.com',
  'DOMAIN-SUFFIX,msn.com',
  'DOMAIN-SUFFIX,visualstudio.com',
];

const APPLE_RULES = [
  'DOMAIN-SUFFIX,apple.com',
  'DOMAIN-SUFFIX,icloud.com',
  'DOMAIN-SUFFIX,icloud-content.com',
  'DOMAIN-SUFFIX,apple-cloudkit.com',
  'DOMAIN-SUFFIX,mzstatic.com',
  'DOMAIN-SUFFIX,aaplimg.com',
  'DOMAIN-SUFFIX,cdn-apple.com',
];

const DEV_RULES = [
  'DOMAIN-SUFFIX,github.com',
  'DOMAIN-SUFFIX,githubusercontent.com',
  'DOMAIN-SUFFIX,githubassets.com',
  'DOMAIN-SUFFIX,github.io',
  'DOMAIN-SUFFIX,npmjs.org',
  'DOMAIN-SUFFIX,yarnpkg.com',
  'DOMAIN-SUFFIX,pypi.org',
  'DOMAIN-SUFFIX,pythonhosted.org',
  'DOMAIN-SUFFIX,crates.io',
  'DOMAIN-SUFFIX,rust-lang.org',
  'DOMAIN-SUFFIX,go.dev',
  'DOMAIN-SUFFIX,golang.org',
  'DOMAIN-SUFFIX,docker.com',
  'DOMAIN-SUFFIX,docker.io',
  'DOMAIN-SUFFIX,ghcr.io',
  'DOMAIN-SUFFIX,stackoverflow.com',
  'DOMAIN-SUFFIX,cloudflare.com',
  'DOMAIN-SUFFIX,cloudflare.net',
  'DOMAIN-SUFFIX,workers.dev',
  'DOMAIN-SUFFIX,jsdelivr.net',
  'DOMAIN-SUFFIX,unpkg.com',
  'DOMAIN-SUFFIX,vercel.app',
  'DOMAIN-SUFFIX,netlify.app',
  'DOMAIN-SUFFIX,gitlab.com',
  'DOMAIN-SUFFIX,bitbucket.org',
  'DOMAIN-SUFFIX,huggingface.co',
  'DOMAIN-SUFFIX,tailwindcss.com',
  'DOMAIN-SUFFIX,jquery.com',
];

// ─────────────────────────── 分组规模 ───────────────────────────
// 'compact' 精简（默认）：同类服务合并成一组，去掉重复的地区手动组与故障转移 / 拒绝组
// 'full'    完整：每个服务独立成组，保留地区手动组、故障转移与拒绝组
const GROUP_LAYOUT = 'compact';

// ─────────────────────────── 路由模式 ───────────────────────────
// 'proxy-if-matched' 命中规则的才走代理，其余直连（默认）。
//             匹配链：EXTRA_PROXY_RULES → GFW(4481) → GreatFire(12) → TldNotCN(829) → ProxyList(27288)
//             → 末条 MATCH 直连；服务表与拒绝集在更前面照常命中。
//             优点：只有列表里的站花代理流量，AWS / Cloudflare 前置的中转站、API 网关这类
//             「海外但能直连」的站不需要逐条补；缺点：上游墙站表漏掉的被墙站会直连失败，
//             只能补进 EXTRA_PROXY_RULES。
// 'direct-if-matched' 命中直连规则的才直连，其余走代理。
//             匹配链：Private → Direct → LanCIDR → CNCIDR → .cn → GEOIP,CN → 末条 MATCH 代理。
//             优点是被墙的站一个不漏；缺点是没有域名规则命中的境外可直连站点也会进代理。
// 旧值兼容：'whitelist' = 'proxy-if-matched'，'geo' = 'direct-if-matched'。
const ROUTING_MODE = 'proxy-if-matched';
const ROUTE_MODE = { geo: 'direct-if-matched', whitelist: 'proxy-if-matched' }[ROUTING_MODE] ?? ROUTING_MODE;
const PROXY_IF_MATCHED = ROUTE_MODE !== 'direct-if-matched';

// ─────────────────────────── Tailscale 接入方式 ───────────────────────────
// 'direct'   本机已装官方 Tailscale（Windows / 桌面）。tailnet 流量强制直连，
//            MagicDNS 交给 100.100.100.100，其他设备可反向连入本机。
// 'outbound' 本机未装官方 Tailscale（Android 单 VPN 槽位）。由 FlClash 内置 tsnet
//            出站接入 tailnet，仅出站：本机能访问 tailnet 设备，其他设备无法连入本机。
//            需要 mihomo ≥ v1.19.25（FlClash ≥ 0.8.93），低版本会因未知节点类型拒绝加载。
const TAILSCALE_MODE = 'direct';

// 'outbound' 模式的节点参数（'direct' 模式下不生效）
const TAILSCALE_NODE = {
  name: '🏠 Tailscale',
  group: 'Tailscale',
  hostname: 'flclash-android',
  authKey: '', // 留空则首次命中时在 FlClash 日志里打开登录链接完成授权
  controlUrl: 'https://controlplane.tailscale.com',
  stateDir: './tailscale',
};

// 网段、MagicDNS、控制面/DERP 域名。这些流量一旦被送进机场代理，
// tailnet 内其他设备就无法连入本机，MagicDNS 名称也会被解析成 fake-ip。
const TAILSCALE_RULES = [
  'DOMAIN-SUFFIX,ts.net', // MagicDNS 域名后缀
  'DOMAIN-SUFFIX,tailscale.com', // 登录、控制面、DERP 中继
  'DOMAIN-SUFFIX,tailscale.io',
  'IP-CIDR,100.64.0.0/10,no-resolve', // CGNAT 段：节点地址与 MagicDNS 解析器 100.100.100.100
  'IP-CIDR6,fd7a:115c:a1e0::/48,no-resolve', // Tailscale IPv6 段
];

// MagicDNS 解析器：tailscaled 在本机监听的固定地址，直接查询可避开 system 解析被 TUN 再次劫持
const TAILSCALE_DNS = '100.100.100.100';

const isTailscaleOutbound = () => TAILSCALE_MODE === 'outbound';

const DIRECT_RULES = [
  'DOMAIN-SUFFIX,lan',
  'DOMAIN-SUFFIX,local',
  'DOMAIN-SUFFIX,localhost',
  'DOMAIN-SUFFIX,home.arpa',
  'DOMAIN-SUFFIX,msftconnecttest.com',
  'DOMAIN-SUFFIX,msftncsi.com',
  'DOMAIN-SUFFIX,npmmirror.com',
  // Google 统计（GA/GTM）在国内有可达端点：211.95.34.129 / .137，直连分别返回 204 / 200。
  // 这里只放精确域名；region1 之类的区域上报端点走广告拦截，见 buildRules 的 ANALYTICS 段。
  'DOMAIN,www.google-analytics.com',
  'DOMAIN,www.googletagmanager.com',
  'DOMAIN,cn.bing.com',
  'IP-CIDR,10.0.0.0/8,no-resolve',
  'IP-CIDR,127.0.0.0/8,no-resolve',
  'IP-CIDR,169.254.0.0/16,no-resolve',
  'IP-CIDR,172.16.0.0/12,no-resolve',
  'IP-CIDR,192.168.0.0/16,no-resolve',
  'IP-CIDR,224.0.0.0/4,no-resolve',
  'IP-CIDR6,::1/128,no-resolve',
  'IP-CIDR6,fc00::/7,no-resolve',
  'IP-CIDR6,fe80::/10,no-resolve',
];

// ── 补充直连 ──
// 规则库漏判的站，命中即直连，排在广告拦截之前。
// 为什么需要：GEOIP,CN 只能判「解析出来的 IP 在国内」，对 Cloudflare / 海外 CDN 前置的
// 国内站点完全无效（解析到 104.21.x / 172.67.x），这些域名只能靠域名规则命中。
// 维护方式：发现某个国内站点被送进了代理，就把域名加在这里，一条一行。
const EXTRA_DIRECT_RULES = [
  'DOMAIN-SUFFIX,jiji.cc', // 吉吉API（AI 中转站），Cloudflare 前置，国内可直连
  // DeepSeek：chat/api/www/platform 在国内解析出 116.205.40.x / 61.241.148.62（华为云），直连可用。
  // 注意 hif-dliq.deepseek.com 是例外——它 CNAME 到华为云 WAF，全网只有 AAAA，
  // dns.ipv6 关闭时任何出口都拿不到地址；要让这类功能可用只能开 dns.ipv6，见 readme。
  'DOMAIN-SUFFIX,deepseek.com',
  // 稳定AI 中转（3.25.52.22，AWS 新加坡，直连 443 可达、/v1/models 返回 401 即服务在线）。
  // 这类海外可直连的中转站 GEOIP,CN 永远判不出来，只能按域名放行。
  'DOMAIN-SUFFIX,wendingai.future1.us',
];

// 补充代理（仅 ROUTING_MODE = 'proxy-if-matched' 时生效）：
// 该模式兜底直连，GFW / GreatFire / TldNotCN / ProxyList 没收录的被墙站点会直连失败，把域名加在这里兜住。
// 一条一行、只写匹配条件，目标统一是「节点选择」；要指定某个服务组请改服务表里的 rules。
const EXTRA_PROXY_RULES = [
  // 示例：'DOMAIN-SUFFIX,example.com',
];

const FAKE_IP_FILTER = [
  '*.lan',
  '*.local',
  '*.localhost',
  '*.test',
  'localhost.ptlogin2.qq.com',
  '+.stun.*.*',
  '+.stun.*.*.*',
  '+.stun.*.*.*.*',
  'lens.l.google.com',
  '*.srv.nintendo.net',
  '+.stun.playstation.net',
  'xbox.*.*.microsoft.com',
  '*.*.xboxlive.com',
  '+.msftncsi.com',
  '+.msftconnecttest.com',
  '+.lan',
  '+.local',
  '+.tailscale.com',
  '+.tailscale.io',
];

// ── Loyalsoldier/clash-rules：全部判定来源 ──
// 同一个项目、同一套 release 产物，每日构建；条目格式是 yaml payload（`  - 'x'`），
// 域名集用 behavior: domain，网段集用 behavior: ipcidr（cncidr / lancidr / telegramcidr）。
const LOYAL = 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release';

const RULE_PROVIDERS = {
  // 广告：20.4 万条，替代原先的 217heidai adblock（少一个外部源，覆盖面相当）
  Reject: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/reject.txt`,
    path: './rules/reject.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 直连：11 万条域名，含国内站与国内可达的海外 CDN，是「该直连」的主判定表
  Direct: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/direct.txt`,
    path: './rules/direct.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 代理：2.7 万条「通常该走代理」的域名，白名单模式的主要来源
  ProxyList: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/proxy.txt`,
    path: './rules/proxy.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 被墙：GFWList 系 + GreatFire 系，白名单模式用
  GFW: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/gfw.txt`,
    path: './rules/gfw.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  GreatFire: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/greatfire.txt`,
    path: './rules/greatfire.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 非中国 TLD（.gov / .mil 之类，829 条），白名单模式兜住直连必挂的站
  TldNotCN: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/tld-not-cn.txt`,
    path: './rules/tld-not-cn.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 私有域名（路由器、NAS 管理页）与局域网段
  Private: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/private.txt`,
    path: './rules/private.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  LanCIDR: {
    type: 'http',
    behavior: 'ipcidr',
    url: `${LOYAL}/lancidr.txt`,
    path: './rules/lancidr.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 国内 IP 段（9665 条），比内置 MaxMind GEOIP 库更贴近实际归属
  CNCIDR: {
    type: 'http',
    behavior: 'ipcidr',
    url: `${LOYAL}/cncidr.txt`,
    path: './rules/cncidr.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  // 服务分类：挂到对应服务组，作为手写规则之后的补充覆盖
  Google: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/google.txt`,
    path: './rules/google.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  Apple: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/apple.txt`,
    path: './rules/apple.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  ICloud: {
    type: 'http',
    behavior: 'domain',
    url: `${LOYAL}/icloud.txt`,
    path: './rules/icloud.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  Telegram: {
    type: 'http',
    behavior: 'ipcidr',
    url: `${LOYAL}/telegramcidr.txt`,
    path: './rules/telegramcidr.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
};

// ─────────────────────────── 服务表 ───────────────────────────
// 新增/删除服务只改这一张表：
//   name          服务组名，同时也是规则命中目标
//   rules         该服务的分流规则（写到 rules 里的原始行，目标组自动补）
//   sets          额外引用的规则集（键名见 RULE_PROVIDERS），目标同样自动补成本服务组
//   priority      必须在广告拦截之前命中的规则（放行被误杀的端点、抢在别家规则前分类）
//   preferRegions 优先排在前面的地区自动组（如 'JP' → 日本-自动）
//   directFirst   直连优先（国内可用服务），DNS 不切境外
//   allowDirect   组内末尾附带 DIRECT 作为兜底
//   dnsVia        'self' 用本服务组解析 DNS，缺省走 OVERSEAS_DNS_GROUP
//   icon          分组图标 URL（FlClash 列表视图显示）
//   pin           分组置顶（紧跟入口组），便于在界面上一眼看到
const SERVICES = [
  {
    name: 'Claude',
    rules: CLAUDE_RULES,
    preferRegions: ['JP', 'US'],
    dnsVia: 'self',
    icon: ICON.ai,
  },
  {
    name: 'AI',
    rules: [...OPENCODE_RULES, ...AI_RULES],
    priority: AI_PRIORITY_RULES,
    dnsVia: 'self',
    icon: ICON.ai,
  },
  {
    name: 'Copilot',
    rules: COPILOT_RULES,
    allowDirect: true,
    dnsVia: 'self',
    icon: ICON.copilot,
  },
  { name: 'YouTube', rules: YOUTUBE_RULES, allowDirect: true, icon: ICON.youtube },
  { name: 'Google', rules: GOOGLE_RULES, sets: ['Google'], allowDirect: true, icon: ICON.google },
  { name: 'Telegram', rules: TELEGRAM_RULES, sets: ['Telegram'], allowDirect: true, icon: ICON.telegram },
  { name: '社交', rules: SOCIAL_RULES, allowDirect: true, icon: ICON.social },
  { name: '流媒体', rules: MEDIA_RULES, allowDirect: true, icon: ICON.streaming },
  { name: '微软', rules: MICROSOFT_RULES, directFirst: true, icon: ICON.system },
  { name: '苹果', rules: APPLE_RULES, sets: ['ICloud', 'Apple'], directFirst: true, icon: ICON.apple },
  { name: '开发者', rules: DEV_RULES, allowDirect: true, icon: ICON.developer },
];

// 精简布局：同类服务合并，AI 已包含 OpenCode
const COMPACT_SERVICES = [
  {
    name: 'AI',
    rules: [...OPENCODE_RULES, ...CLAUDE_RULES, ...AI_RULES, ...COPILOT_RULES],
    priority: AI_PRIORITY_RULES,
    preferRegions: ['JP', 'US'],
    allowDirect: true,
    dnsVia: 'self',
    pin: true,
    icon: ICON.ai,
  },
  {
    name: '媒体',
    rules: [...YOUTUBE_RULES, ...GOOGLE_RULES, ...MEDIA_RULES],
    sets: ['Google'],
    allowDirect: true,
    icon: ICON.media,
  },
  {
    name: '社交',
    rules: [...TELEGRAM_RULES, ...SOCIAL_RULES],
    sets: ['Telegram'],
    allowDirect: true,
    icon: ICON.social,
  },
  {
    name: '系统',
    rules: [...MICROSOFT_RULES, ...APPLE_RULES],
    sets: ['ICloud', 'Apple'],
    directFirst: true,
    icon: ICON.system,
  },
  { name: '开发者', rules: DEV_RULES, allowDirect: true, icon: ICON.developer },
];

const isCompact = () => GROUP_LAYOUT === 'compact';
const activeServices = () => (isCompact() ? COMPACT_SERVICES : SERVICES);

// ─────────────────────────── 工具函数 ───────────────────────────

function regionOf(name) {
  return REGIONS.find((region) => region.re.test(name)) ?? OTHER_REGION;
}


function listGroup(name, proxies, extra = {}) {
  return { name, type: 'select', proxies, ...extra };
}

function testGroup(name, proxies, type = 'url-test', extra = {}) {
  return {
    name,
    type,
    proxies,
    url: TEST_URL,
    interval: INTERVAL,
    lazy: LAZY,
    ...extra,
  };
}

function withTarget(line, target) {
  const parts = line.split(',');
  if (parts[parts.length - 1].trim() === 'no-resolve') {
    parts.splice(parts.length - 1, 0, target);
    return parts.join(',');
  }
  return `${line},${target}`;
}

function uniq(items) {
  return [...new Set(items)];
}

// mihomo 要求节点名唯一：与订阅节点撞名时追加序号
function uniqueName(base, taken) {
  let name = base;
  for (let i = 2; taken.has(name); i += 1) name = `${base} ${i}`;
  return name;
}

// ─────────────────────────── 节点归类 ───────────────────────────

/**
 * 只归类，不动节点：订阅里的节点名称、顺序、字段原样保留。
 * 这里算出来的 regionMembers 决定「地区组引用哪些名字」，hiddenNames 是那些
 * 不该进任何分组的伪节点（官网、群组公告、流量/到期信息节点）。
 */
function classifyProxies(rawProxies) {
  const regionBuckets = new Map();
  for (const region of [...REGIONS, OTHER_REGION]) {
    regionBuckets.set(region.key, []);
  }

  const hiddenNames = new Set();

  for (const proxy of rawProxies) {
    const name = typeof proxy?.name === 'string' ? proxy.name : '';
    if (!name) continue;

    // 官网、群组、公告、流量/到期信息节点：留在 proxies 里，只是不参与分组与测速
    if (JUNK_NODE.test(name) || INFO_NODE.test(name) || /^📊|📅/.test(name)) {
      hiddenNames.add(name);
      continue;
    }

    regionBuckets.get(regionOf(name).key).push(name);
  }

  const regionMembers = new Map();
  for (const region of [...REGIONS, OTHER_REGION]) {
    const members = regionBuckets.get(region.key) ?? [];
    if (members.length > 0) regionMembers.set(region.name, uniq(members));
  }

  return { regionMembers, hiddenNames };
}


// ─────────────────────────── 分组构建 ───────────────────────────

function buildGroups(ctx) {
  const { nodeNames, providerKeys, regionMembers } = ctx;
  // 订阅只给 provider 时无法枚举节点，地区维度直接跳过
  const enumrable = nodeNames.length > 0;
  const compact = isCompact();

  const regionAuto = [];
  const regionManual = [];
  const regionAutoByKey = new Map();

  if (enumrable) {
    for (const region of [...REGIONS, OTHER_REGION]) {
      const members = regionMembers.get(region.name);
      if (!members || members.length === 0) continue;
      const autoName = `${region.name}-自动`;
      regionAutoByKey.set(region.key, autoName);
      regionAuto.push(
        testGroup(autoName, members, 'url-test', {
          tolerance: TOLERANCE,
          icon: iconUrl(region.icon),
        }),
      );
      // 地区手动组与自动组内容重复，精简布局只留自动组
      if (!compact) {
        regionManual.push(
          listGroup(region.name, uniq([autoName, ...members]), { icon: iconUrl(region.icon) }),
        );
      }
    }
  }

  const regionNames = regionManual.map((group) => group.name);
  const regionAutoNames = regionAuto.map((group) => group.name);

  // provider 订阅拿不到节点名，只能靠 use 引用成员；exclude-filter 与 JS 侧过滤保持一致，
  // 避免 provider 里的公告 / 到期节点混进手动列表。
  const attachProviders = (group) => {
    if (providerKeys.length > 0) {
      group.use = providerKeys;
      group['exclude-filter'] = NOTICE_PATTERN;
    }
    return group;
  };

  // 测速类分组：内联节点直接列名字；provider 订阅由 use 提供成员。
  const nodeGroup = (name, proxies, type, extra) =>
    attachProviders(testGroup(name, proxies, type, extra));

  // 自动测速：url-test 类型，负责在全部节点里择优。
  const autoTestGroup = nodeGroup(GROUP.autoTest, nodeNames, 'url-test', {
    tolerance: TOLERANCE,
    icon: ICON.autoTest,
  });
  // 「自动选择」做成 select：默认选中自动测速，同时允许手动选中任意节点。
  // url-test / fallback 类型本身不可手选，所以单独拆出自动测速子组保留择优能力。
  const autoGroup = attachProviders(
    listGroup(GROUP.auto, uniq([GROUP.autoTest, ...nodeNames]), { icon: ICON.auto }),
  );
  // 精简布局不建故障转移与拒绝组：自动选择已覆盖测速择优，广告拦截直接指向 REJECT
  const fallbackGroup = compact
    ? null
    : nodeGroup(GROUP.fallback, nodeNames, 'fallback', { icon: ICON.fallback });

  // 中文直连组与拒绝组：封装底层 DIRECT 与 REJECT，界面全部中文展现
  const directGroup = listGroup(GROUP.direct, ['DIRECT'], { icon: ICON.direct });
  const rejectGroup = compact ? null : listGroup(GROUP.reject, ['REJECT'], { icon: ICON.reject });

  const entryGroup = attachProviders(
    listGroup(
      GROUP.entry,
      uniq([
        GROUP.auto,
        ...(fallbackGroup ? [GROUP.fallback] : []),
        GROUP.direct,
        ...(compact ? regionAutoNames : regionNames),
        ...nodeNames,
      ]),
      { icon: ICON.entry },
    ),
  );

  // 服务组：默认自动择优，可手动覆盖
  const serviceGroup = (service) => {
    const preferred = (service.preferRegions ?? [])
      .map((key) => regionAutoByKey.get(key))
      .filter(Boolean);

    const proxies = uniq([
      ...(service.directFirst ? [GROUP.direct] : []),
      ...preferred,
      GROUP.auto,
      ...(fallbackGroup ? [GROUP.fallback] : []),
      ...(compact ? regionAutoNames : regionNames),
      ...nodeNames,
      ...(service.allowDirect || service.directFirst ? [GROUP.direct] : []),
    ]);
    // 服务组同样是 select：除了自动 / 地区 / 内联节点，再挂 provider 引用，
    // 保证只有 proxy-providers 的订阅也能在这里手动选中具体节点。
    return attachProviders(listGroup(service.name, proxies, { icon: service.icon }));
  };

  const services = activeServices();
  const serviceGroups = services.map(serviceGroup);
  const pinned = services.map((service, index) => (service.pin ? index : -1)).filter((i) => i >= 0);

  const adblockGroup = listGroup(
    GROUP.adblock,
    compact ? ['REJECT', GROUP.direct] : [GROUP.reject, GROUP.direct],
    { icon: ICON.adblock },
  );

  const groups = [
    entryGroup,
    autoGroup,
    autoTestGroup,
    fallbackGroup,
    directGroup,
    ...regionAuto,
    ...regionManual,
    ...serviceGroups.filter((_, index) => !pinned.includes(index)),
    adblockGroup,
    rejectGroup,
  ].filter(Boolean);

  // 置顶服务组紧跟入口组，其余服务组收尾
  if (pinned.length > 0) {
    groups.splice(1, 0, ...pinned.map((index) => serviceGroups[index]));
  }

  return { groups, regionAutoByKey };
}

// ─────────────────────────── 规则构建 ───────────────────────────

function buildRules() {
  const tailscaleTarget = isTailscaleOutbound() ? TAILSCALE_NODE.group : GROUP.direct;
  const services = activeServices();

  // 服务放行：service.priority 里的规则排在广告拦截之前，避免被广告库误判成 REJECT
  const allowRules = services.flatMap((service) =>
    (service.priority ?? []).map((rule) => withTarget(rule, service.name)),
  );

  // 统计上报的区域端点（如 region1.google-analytics.com → 216.239.32/34.36）国内直连必超时，
  // 挂到直连只会让页面里的 GA4 请求卡到超时。送到广告拦截组（默认 REJECT）立即断开，页面无感。
  // 可达的精确域名已在 DIRECT_RULES 里放行，不会被这条 suffix 覆盖。
  const analyticsRules = [
    'DOMAIN-SUFFIX,google-analytics.com',
    'DOMAIN-SUFFIX,googletagmanager.com',
  ].map((rule) => withTarget(rule, GROUP.adblock));

  // 服务分流：手写规则在前（更精确），服务分类规则集在后（更宽覆盖）
  const serviceRules = services.flatMap((service) => [
    ...(service.rules ?? []).map((rule) => withTarget(rule, service.name)),
    ...(service.sets ?? []).map((set) => `RULE-SET,${set},${service.name}`),
  ]);

  const lines = [
    // 1. Tailscale 网段 / 控制面 / MagicDNS
    ...TAILSCALE_RULES.map((rule) => withTarget(rule, tailscaleTarget)),
    // 2. 本机与内网
    ...DIRECT_RULES.map((rule) => withTarget(rule, GROUP.direct)),
    // 3. 规则库漏判的国内站点（CDN 前置，GEOIP 判不出）
    ...EXTRA_DIRECT_RULES.map((rule) => withTarget(rule, GROUP.direct)),
    // 4. 服务放行：必须早于拒绝集
    ...allowRules,
    // 5. 统计上报的残留子域：立即断开，别再落到直连或代理
    ...analyticsRules,
    // 6. 广告：Loyalsoldier reject.txt
    `RULE-SET,Reject,${GROUP.adblock}`,
    // 7. 服务分流
    ...serviceRules,
  ];

  // 8. 兜底：两种模式只在这里分叉
  const tail = PROXY_IF_MATCHED
    ? [
        // proxy-if-matched：先送走自己补的站与上游墙站表，其余一律直连
        ...EXTRA_PROXY_RULES.map((rule) => withTarget(rule, GROUP.entry)),
        `RULE-SET,GFW,${GROUP.entry}`,
        `RULE-SET,GreatFire,${GROUP.entry}`,
        `RULE-SET,TldNotCN,${GROUP.entry}`,
        `RULE-SET,ProxyList,${GROUP.entry}`,
        `MATCH,${GROUP.direct}`,
      ]
    : [
        // direct-if-matched：私有 / 直连域名 → 局域网段 → 国内 IP 段 → .cn → GEOIP → 其余走代理
        `RULE-SET,Private,${GROUP.direct}`,
        `RULE-SET,Direct,${GROUP.direct}`,
        `RULE-SET,LanCIDR,${GROUP.direct}`,
        `RULE-SET,CNCIDR,${GROUP.direct}`,
        `DOMAIN-SUFFIX,cn,${GROUP.direct}`,
        `GEOIP,CN,${GROUP.direct}`,
        `MATCH,${GROUP.entry}`,
      ];

  // 去重（同一行只保留首次出现，保持命中顺序）
  return uniq([...lines, ...tail]);
}

// ─────────────────────────── DNS 构建 ───────────────────────────

function buildDns(validNames) {
  const policy = { '+.cn': CN_DNS, '+.lan': 'system', '+.local': 'system' };

  for (const service of activeServices()) {
    // 直连优先的服务不该把 DNS 交给代理组解析
    if (service.directFirst) continue;

    const target = service.dnsVia === 'self' ? service.name : OVERSEAS_DNS_GROUP;
    if (!validNames.has(target)) continue;

    // priority 里的域名同样按服务出口解析（如 ogads 走 AI 组，避免国内 DoH 解析出被墙地址）
    for (const rule of [...(service.priority ?? []), ...(service.rules ?? [])]) {
      const [type, value] = rule.split(',');
      if (!value) continue;
      if (type === 'DOMAIN') {
        policy[value] = FOREIGN_DNS.map((dns) => `${dns}#${target}`);
      } else if (type === 'DOMAIN-SUFFIX' && !value.endsWith('.cn')) {
        policy[`+.${value}`] = FOREIGN_DNS.map((dns) => `${dns}#${target}`);
      }
    }
  }

  // 'outbound' 模式依赖 fake-ip 把域名交给 tsnet 的 MagicDNS，不能把 ts.net 排除出 fake-ip
  const fakeIpFilter = isTailscaleOutbound() ? FAKE_IP_FILTER : [...FAKE_IP_FILTER, '+.ts.net'];

  // MagicDNS 名称只认 Tailscale 本地解析器，避免走代理组 DoH 或被 fake-ip 接管
  if (!isTailscaleOutbound()) policy['+.ts.net'] = [TAILSCALE_DNS];

  return {
    enable: true,
    ipv6: false,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter-mode': 'blacklist',
    'fake-ip-filter': fakeIpFilter,
    'use-hosts': true,
    'respect-rules': false,
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    nameserver: CN_DNS,
    'proxy-server-nameserver': CN_DNS,
    'direct-nameserver': CN_DNS,
    'nameserver-policy': policy,
  };
}

// ─────────────────────────── 主流程 ───────────────────────────

function main(config) {
  const rawProxies = Array.isArray(config.proxies) ? config.proxies : [];
  const providerKeys = Object.keys(config['proxy-providers'] ?? {});

  if (rawProxies.length === 0 && providerKeys.length === 0) {
    console.warn('订阅里既没有 proxies 也没有 proxy-providers，跳过覆写');
    return config;
  }

  // 1. 按地区归类：节点本身原样保留（名称、顺序、字段都不改）
  const { regionMembers, hiddenNames } = classifyProxies(rawProxies);
  const proxies = rawProxies.slice();

  // 参与分组与测速的节点（排除官网、公告、流量/到期信息节点）
  const nodeNames = proxies
    .map((proxy) => proxy?.name)
    .filter((name) => typeof name === 'string' && name && !hiddenNames.has(name));

  if (rawProxies.length > 0 && nodeNames.length === 0 && providerKeys.length === 0) {
    console.warn('订阅里没有可用节点，保留原始配置');
    return config;
  }

  // Tailscale 内置出站节点：仅 outbound 模式注入，不进入自动选择、故障转移与入口组
  let tailscaleNodeName = null;
  if (isTailscaleOutbound()) {
    // 与订阅节点撞名会覆盖原节点，撞上就追加序号
    const taken = new Set(proxies.map((proxy) => proxy?.name).filter(Boolean));
    tailscaleNodeName = uniqueName(TAILSCALE_NODE.name, taken);
    proxies.push({
      name: tailscaleNodeName,
      type: 'tailscale',
      hostname: TAILSCALE_NODE.hostname,
      'control-url': TAILSCALE_NODE.controlUrl,
      'state-dir': TAILSCALE_NODE.stateDir,
      ephemeral: false,
      udp: true,
      'accept-routes': true,
      'ip-version': 'ipv4-prefer',
      ...(TAILSCALE_NODE.authKey ? { 'auth-key': TAILSCALE_NODE.authKey } : {}),
    });
  }

  // 2~5. 分组
  const ctx = { nodeNames, providerKeys, regionMembers };
  const { groups } = buildGroups(ctx);

  // Tailscale 策略组紧跟入口组：默认走内置节点，可手动切回直连逃生
  if (tailscaleNodeName) {
    groups.splice(
      1,
      0,
      listGroup(TAILSCALE_NODE.group, [tailscaleNodeName, GROUP.direct], { icon: ICON.tailscale }),
    );
  }

  // 6. 规则
  const rules = buildRules();

  // 7. 引用校验：mihomo 遇到不存在的组名会拒绝加载整个配置
  const reserved = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE']);
  const valid = new Set([...proxies.map((p) => p.name), ...groups.map((group) => group.name), ...reserved]);

  // 校验 rules 中的 target 是否有效，若引用了不存在的目标则降级为 DIRECT 并告警
  const validatedRules = [];
  for (const rule of rules) {
    const parts = rule.split(',');
    const hasNoResolve = parts[parts.length - 1].trim() === 'no-resolve';
    const targetIndex = hasNoResolve ? parts.length - 2 : parts.length - 1;
    const target = parts[targetIndex]?.trim();
    if (target && !valid.has(target)) {
      console.warn(`规则 [${rule}] 引用了未知目标 [${target}]，自动降级为直连`);
      parts[targetIndex] = GROUP.direct;
      validatedRules.push(parts.join(','));
    } else {
      validatedRules.push(rule);
    }
  }
  for (const group of groups) {
    const dropped = (group.proxies ?? []).filter((name) => !valid.has(name));
    if (dropped.length > 0) {
      console.warn(`${group.name} 丢弃未知引用：${dropped.join(', ')}`);
    }
    const kept = uniq((group.proxies ?? []).filter((name) => valid.has(name)));

    if (kept.length > 0) {
      group.proxies = kept;
    } else if (Array.isArray(group.use) && group.use.length > 0) {
      // 只靠 provider 供节点：省略空列表，由 use 提供成员
      delete group.proxies;
    } else {
      console.warn(`${group.name} 没有可用成员，回退直连`);
      group.proxies = [GROUP.direct];
    }
  }

  // 8. DNS
  const dns = buildDns(valid);

  // 只下发实际被引用的规则集：proxy-if-matched 不会去下 11 万条的 direct，direct-if-matched 也不会去下 2.7 万条的 proxy
  const usedSets = new Set(
    validatedRules
      .filter((rule) => rule.startsWith('RULE-SET,'))
      .map((rule) => rule.split(',')[1]),
  );
  const ruleProviders = Object.fromEntries(
    Object.entries(RULE_PROVIDERS).filter(([key]) => usedSets.has(key)),
  );

  console.log(
    `保留 ${nodeNames.length} 个节点${providerKeys.length ? `、引用 ${providerKeys.length} 个 provider` : ''}，` +
      `生成 ${groups.length} 个分组、${rules.length} 条规则、${Object.keys(ruleProviders).length} 个规则集` +
      `（布局 ${GROUP_LAYOUT}，路由 ${ROUTE_MODE}，Tailscale ${TAILSCALE_MODE}）`,
  );

  return {
    ...config,
    proxies,
    'proxy-groups': groups,
    rules: validatedRules,
    'rule-providers': { ...(config['rule-providers'] ?? {}), ...ruleProviders },
    dns,
    'store-selected': true,
    'store-fake-ip': true,
    'unified-delay': true,
    'tcp-concurrent': true,
    'find-process-mode': config['find-process-mode'] ?? 'strict',
  };
}
