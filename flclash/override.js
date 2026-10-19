// FlClash 扩展/覆写脚本
// 需求：不重构分组，只在 rules 前追加 opencode.ai 规则，分流到“节点选择 / 手动选择”（或回退到默认代理组）

const OPENCODE_RULES = [
  "DOMAIN-SUFFIX,opencode.ai",
  "DOMAIN-KEYWORD,opencode",
];

/**
 * 自动寻找订阅中存在的“节点选择”或默认代理策略组
 * 匹配优先级：节点选择 / 手动选择 / PROXY / 代理 / 第一个有效选择组
 */
function getTargetGroup(proxyGroups) {
  if (!Array.isArray(proxyGroups) || proxyGroups.length === 0) {
    return "PROXY";
  }

  // 常见手动选择/默认代理组名
  const candidateRegex = /(节点选择|手动选择|Select|PROXY|Proxy|代理|梯子|节点)/i;

  const matched = proxyGroups.find(
    (g) => g && g.name && candidateRegex.test(g.name) && g.type === "select"
  );
  if (matched) {
    return matched.name;
  }

  // 若无特定正则命中，优先找第一个 select 类型的组
  const firstSelect = proxyGroups.find((g) => g && g.type === "select");
  if (firstSelect) {
    return firstSelect.name;
  }

  // 最终保底回退
  return proxyGroups[0]?.name || "PROXY";
}

/**
 * FlClash 入口函数
 * @param {Object} config - 原始订阅配置对象
 * @returns {Object} 修改后的配置对象
 */
function main(config) {
  // 确保 rules 存在
  if (!Array.isArray(config.rules)) {
    config.rules = [];
  }

  // 确保 proxy-groups 存在
  const proxyGroups = config["proxy-groups"] || [];

  // 获取目标策略组名称
  const targetGroup = getTargetGroup(proxyGroups);

  // 构造待追加的规则（插入在最前，保证高优先级生效）
  const rulesToPrepend = OPENCODE_RULES.map((rule) => `${rule},${targetGroup}`);

  // 去重追加：过滤掉已存在的相同规则
  const existingRules = new Set(config.rules);
  const filteredNewRules = rulesToPrepend.filter((r) => !existingRules.has(r));

  config.rules = [...filteredNewRules, ...config.rules];

  console.log(`[FlClash Script] OpenCode 规则追加完成，目标策略组: ${targetGroup}`);
  return config;
}
