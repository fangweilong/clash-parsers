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
 *   1. 剔除纯广告、官网、群组等无用节点；
 *   2. 自动提取「剩余套餐/可用流量」与「到期时间」，合并为单个中文状态节点置顶显示在「节点选择」前排，
 *      不参与自动测速与故障转移，避免测速污染；
 *   3. 真实节点按地区归类聚集并连续编号（如 `🇭🇰 香港 01`、`🇯🇵 日本 01`），无冗余协议后缀；
 *   4. 重建分组：入口 / 自动 / 故障转移 / 直连 / 地区（自动+手动）/ 服务 / 广告拦截；
 *      分组规模由 GROUP_LAYOUT 控制（默认 compact：合并同类服务、去掉重复地区手动组与故障转移/拒绝组），
 *      每个分组附带 icon（FlClash 列表视图显示）；
 *      原本英文的 DIRECT 与 REJECT 统一映射为中文「直连」与「拒绝」策略组，界面告别冷冰冰的英文；
 *   5. 重建规则：按服务分组 + 广告拦截 + 国内直连，命中顺序显式且无重复；
 *      Tailscale 支持两种接入方式（脚本顶部 TAILSCALE_MODE）：
 *      `direct` 本机已装官方客户端，网段与 ts.net 强制直连、MagicDNS 走 100.100.100.100；
 *      `outbound` 未装官方客户端（Android），注入 type: tailscale 出站节点，仅能主动访问 tailnet；
 *   6. 重建 DNS：默认国内 DoH，境外域名按服务走对应出口解析，
 *      避免原订阅「nameserver 指向代理组」造成的启动死锁；
 *   7. 订阅只有 proxy-providers（没有内联 proxies）时同样可用：
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
  'DOMAIN-SUFFIX,google-analytics.com',
  'DOMAIN-SUFFIX,googletagmanager.com',
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

const RULE_PROVIDERS = {
  AdBlock: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/217heidai/adblockfilters@main/rules/adblockmihomo.yaml',
    path: './rules/adblock.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
  China: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/China/China_Domain.yaml',
    path: './rules/china.yaml',
    interval: 86400,
    proxy: GROUP.entry,
  },
};

// ─────────────────────────── 服务表 ───────────────────────────
// 新增/删除服务只改这一张表：
//   name          服务组名，同时也是规则命中目标
//   rules         该服务的分流规则（写到 rules 里的原始行，目标组自动补）
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
  { name: 'AI', rules: [...OPENCODE_RULES, ...AI_RULES], dnsVia: 'self', icon: ICON.ai },
  {
    name: 'Copilot',
    rules: COPILOT_RULES,
    allowDirect: true,
    dnsVia: 'self',
    icon: ICON.copilot,
  },
  { name: 'YouTube', rules: YOUTUBE_RULES, allowDirect: true, icon: ICON.youtube },
  { name: 'Google', rules: GOOGLE_RULES, allowDirect: true, icon: ICON.google },
  { name: 'Telegram', rules: TELEGRAM_RULES, allowDirect: true, icon: ICON.telegram },
  { name: '社交', rules: SOCIAL_RULES, allowDirect: true, icon: ICON.social },
  { name: '流媒体', rules: MEDIA_RULES, allowDirect: true, icon: ICON.streaming },
  { name: '微软', rules: MICROSOFT_RULES, directFirst: true, icon: ICON.system },
  { name: '苹果', rules: APPLE_RULES, directFirst: true, icon: ICON.apple },
  { name: '开发者', rules: DEV_RULES, allowDirect: true, icon: ICON.developer },
];

// 精简布局：同类服务合并，AI 已包含 OpenCode
const COMPACT_SERVICES = [
  {
    name: 'AI',
    rules: [...OPENCODE_RULES, ...CLAUDE_RULES, ...AI_RULES, ...COPILOT_RULES],
    preferRegions: ['JP', 'US'],
    allowDirect: true,
    dnsVia: 'self',
    pin: true,
    icon: ICON.ai,
  },
  {
    name: '媒体',
    rules: [...YOUTUBE_RULES, ...GOOGLE_RULES, ...MEDIA_RULES],
    allowDirect: true,
    icon: ICON.media,
  },
  { name: '社交', rules: [...TELEGRAM_RULES, ...SOCIAL_RULES], allowDirect: true, icon: ICON.social },
  { name: '系统', rules: [...MICROSOFT_RULES, ...APPLE_RULES], directFirst: true, icon: ICON.system },
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

function extractTraffic(raw) {
  const m =
    raw.match(/(?:剩余流量|可用流量|剩余套餐|剩余)[：:\s]*([0-9.]+\s*[KMGT]?B?)/i) ||
    raw.match(/([0-9.]+\s*[KMGT]B?)\s*(?:剩余|可用)/i) ||
    raw.match(/(?:总流量|套餐流量|流量)[：:\s]*([0-9.]+\s*[KMGT]?B?)/i);
  return m ? m[1].trim() : null;
}

function extractExpire(raw) {
  const m =
    raw.match(/(?:到期时间|套餐到期|过期时间|到期)[：:\s]*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})/i) ||
    raw.match(/([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})\s*(?:到期|过期)/i) ||
    raw.match(/(?:距离(?:下次)?重置(?:还有)?|重置[日时间]*)[：:\s]*([0-9]+\s*天|每月\s*[0-9]+\s*[号日])/i);
  return m ? m[1].trim() : null;
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

// ─────────────────────────── 节点整理 ───────────────────────────

/**
 * 过滤伪节点并按地区连续编号重命名（同一地区节点聚合在一起）。
 */
function normalizeProxies(rawProxies) {
  const regionBuckets = new Map();
  for (const region of [...REGIONS, OTHER_REGION]) {
    regionBuckets.set(region.key, []);
  }

  let trafficInfo = null;
  let expireInfo = null;
  let sampleDummyProxy = null;

  // 1. 过滤垃圾/官网，提取套餐流量与到期时间，其余按地区分桶
  for (const proxy of rawProxies) {
    const raw = typeof proxy?.name === 'string' ? proxy.name : '';
    if (!raw) continue;

    // 彻底剔除官网、群组等纯推广广告
    if (JUNK_NODE.test(raw)) continue;

    // 提取套餐/到期时间信息（已格式化节点支持幂等重解析）
    if (INFO_NODE.test(raw) || /^📊|📅/.test(raw)) {
      const t = extractTraffic(raw);
      if (t && !trafficInfo) trafficInfo = t;
      const e = extractExpire(raw);
      if (e && !expireInfo) expireInfo = e;
      if (!sampleDummyProxy) sampleDummyProxy = proxy;
      continue;
    }

    const region = regionOf(raw);
    regionBuckets.get(region.key).push({ proxy, raw, region });
  }

  // 2. 按地区顺序归类聚拢，同一地区连续编号（如 🇭🇰 香港 01、🇭🇰 香港 02）
  const proxies = [];
  const renamed = new Map();
  const regionMembers = new Map();

  for (const region of [...REGIONS, OTHER_REGION]) {
    const bucket = regionBuckets.get(region.key) ?? [];
    if (bucket.length === 0) continue;

    const names = [];
    bucket.forEach((item, index) => {
      const num = String(index + 1).padStart(2, '0');
      const name = `${region.flag} ${region.name} ${num}`;
      names.push(name);
      renamed.set(item.raw, name);
      proxies.push({ ...item.proxy, name });
    });

    regionMembers.set(region.name, names);
  }

  // 3. 将提取的套餐与到期时间合并为单个中文状态节点，置于节点列表首位
  let infoNode = null;
  if (trafficInfo || expireInfo) {
    let title = '';
    if (trafficInfo && expireInfo) {
      title = `📊 剩余: ${trafficInfo} | 到期: ${expireInfo}`;
    } else if (trafficInfo) {
      title = `📊 剩余: ${trafficInfo}`;
    } else {
      title = `📅 到期: ${expireInfo}`;
    }

    infoNode = {
      ...(sampleDummyProxy ?? {
        type: 'ss',
        server: '127.0.0.1',
        port: 1080,
        cipher: 'aes-128-gcm',
        password: 'dummy',
      }),
      name: title,
    };
    proxies.unshift(infoNode);
  }

  return { proxies, renamed, regionMembers, infoNode };
}


// ─────────────────────────── 分组构建 ───────────────────────────

function buildGroups(ctx) {
  const { nodeNames, providerKeys, regionMembers, infoNodeName } = ctx;
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

  // 节点出口组：内联节点直接列名字；有 provider 时用 use 引用，
  // 并用与 JS 过滤一致的正则排除 provider 里的伪节点。
  const nodeGroup = (name, proxies, type, extra) => {
    const group = testGroup(name, proxies, type, extra);
    if (providerKeys.length > 0) {
      group.use = providerKeys;
      group['exclude-filter'] = NOTICE_PATTERN;
    }
    return group;
  };

  const autoGroup = nodeGroup(GROUP.auto, nodeNames, 'url-test', {
    tolerance: TOLERANCE,
    icon: ICON.auto,
  });
  // 精简布局不建故障转移与拒绝组：自动选择已覆盖测速择优，广告拦截直接指向 REJECT
  const fallbackGroup = compact
    ? null
    : nodeGroup(GROUP.fallback, nodeNames, 'fallback', { icon: ICON.fallback });

  // 中文直连组与拒绝组：封装底层 DIRECT 与 REJECT，界面全部中文展现
  const directGroup = listGroup(GROUP.direct, ['DIRECT'], { icon: ICON.direct });
  const rejectGroup = compact ? null : listGroup(GROUP.reject, ['REJECT'], { icon: ICON.reject });

  const entryGroup = listGroup(
    GROUP.entry,
    uniq([
      GROUP.auto,
      ...(infoNodeName ? [infoNodeName] : []),
      ...(fallbackGroup ? [GROUP.fallback] : []),
      GROUP.direct,
      ...(compact ? regionAutoNames : regionNames),
      ...nodeNames,
    ]),
    { icon: ICON.entry },
  );
  if (providerKeys.length > 0) {
    entryGroup.use = providerKeys;
    entryGroup['exclude-filter'] = NOTICE_PATTERN;
  }

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
    return listGroup(service.name, proxies, { icon: service.icon });
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
  const lines = [
    ...TAILSCALE_RULES.map((rule) => withTarget(rule, tailscaleTarget)),
    ...DIRECT_RULES.map((rule) => withTarget(rule, GROUP.direct)),
    `RULE-SET,AdBlock,${GROUP.adblock}`,
    ...activeServices().flatMap((service) =>
      (service.rules ?? []).map((rule) => withTarget(rule, service.name)),
    ),
    `RULE-SET,China,${GROUP.direct}`,
    `DOMAIN-SUFFIX,cn,${GROUP.direct}`,
    `GEOIP,CN,${GROUP.direct}`,
    `MATCH,${GROUP.entry}`,
  ];

  // 去重（同一行只保留首次出现，保持命中顺序）
  return uniq(lines);
}

// ─────────────────────────── DNS 构建 ───────────────────────────

function buildDns(validNames) {
  const policy = { '+.cn': CN_DNS, '+.lan': 'system', '+.local': 'system' };

  for (const service of activeServices()) {
    // 直连优先的服务不该把 DNS 交给代理组解析
    if (service.directFirst) continue;

    const target = service.dnsVia === 'self' ? service.name : OVERSEAS_DNS_GROUP;
    if (!validNames.has(target)) continue;

    for (const rule of service.rules ?? []) {
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

  // 1. 过滤伪节点 + 提取合并状态节点 + 重命名
  const { proxies, renamed, regionMembers, infoNode } = normalizeProxies(rawProxies);
  if (rawProxies.length > 0 && proxies.length === 0) {
    console.warn('过滤后没有可用节点，保留原始配置');
    return config;
  }

  // 真实可用节点（排除仅用于展示的状态节点，避免测速污染与故障转移误切）
  const nodeNames = proxies.filter((p) => p !== infoNode).map((proxy) => proxy.name);

  // Tailscale 内置出站节点：仅 outbound 模式注入，不进入自动选择、故障转移与入口组
  let tailscaleNodeName = null;
  if (isTailscaleOutbound()) {
    // 同时避开订阅里的原始名：重命名表会把同名引用改写到订阅节点上
    const taken = new Set([
      ...proxies.map((proxy) => proxy.name),
      ...rawProxies.map((proxy) => proxy?.name).filter(Boolean),
    ]);
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
  const ctx = { nodeNames, providerKeys, regionMembers, infoNodeName: infoNode?.name };
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
    const dropped = (group.proxies ?? []).filter((name) => !valid.has(name) && !renamed.has(name));
    if (dropped.length > 0) {
      console.warn(`${group.name} 丢弃未知引用：${dropped.join(', ')}`);
    }
    const kept = uniq(
      (group.proxies ?? [])
        .map((name) => renamed.get(name) ?? name)
        .filter((name) => valid.has(name)),
    );

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

  console.log(
    `保留 ${nodeNames.length} 个节点${providerKeys.length ? `、引用 ${providerKeys.length} 个 provider` : ''}，` +
      `生成 ${groups.length} 个分组、${rules.length} 条规则（布局 ${GROUP_LAYOUT}，Tailscale ${TAILSCALE_MODE}）`,
  );

  return {
    ...config,
    proxies,
    'proxy-groups': groups,
    rules: validatedRules,
    'rule-providers': { ...(config['rule-providers'] ?? {}), ...RULE_PROVIDERS },
    dns,
    'store-selected': true,
    'store-fake-ip': true,
    'unified-delay': true,
    'tcp-concurrent': true,
    'find-process-mode': config['find-process-mode'] ?? 'strict',
  };
}
