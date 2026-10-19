// FlClash 扩展/覆写脚本
// 需求：不重构原有分组体系，在 proxy-groups 中追加一个专属的 "OpenCode" 策略组（界面可见并可选节点），并在 rules 前追加分流

const OPENCODE_GROUP_NAME = "🤖 OpenCode";

const OPENCODE_RULES = [
  `DOMAIN-SUFFIX,opencode.ai,${OPENCODE_GROUP_NAME}`,
  `DOMAIN-KEYWORD,opencode,${OPENCODE_GROUP_NAME}`,
];

/**
 * 收集当前配置中可用的所有节点名称
 */
function extractAllProxyNames(config) {
  const proxyNames = [];

  // 1. 原生 proxies
  if (Array.isArray(config.proxies)) {
    for (const p of config.proxies) {
      if (p && p.name) {
        proxyNames.push(p.name);
      }
    }
  }

  // 2. 如果 proxies 为空（比如用了 proxy-providers），从现有组的 proxies 中收集
  if (proxyNames.length === 0 && Array.isArray(config["proxy-groups"])) {
    const existingSet = new Set(["DIRECT", "REJECT"]);
    for (const group of config["proxy-groups"]) {
      if (Array.isArray(group.proxies)) {
        for (const name of group.proxies) {
          if (!existingSet.has(name)) {
            proxyNames.push(name);
            existingSet.add(name);
          }
        }
      }
    }
  }

  return proxyNames;
}

/**
 * 获取常用组名作为候选前置项（如 DIRECT、自动选择等）
 */
function getCommonGroupOptions(proxyGroups) {
  const options = ["DIRECT"];
  if (!Array.isArray(proxyGroups)) return options;

  const candidateRegex = /(自动选择|Auto|♻️|故障转移|Fallback|节点选择|手动选择)/i;
  for (const g of proxyGroups) {
    if (g && g.name && candidateRegex.test(g.name) && !options.includes(g.name)) {
      options.push(g.name);
    }
  }
  return options;
}

/**
 * FlClash 入口函数
 * @param {Object} config - 原始订阅配置对象
 * @returns {Object} 修改后的配置对象
 */
function main(config) {
  // 确保关键字段存在
  if (!Array.isArray(config.rules)) {
    config.rules = [];
  }
  if (!Array.isArray(config["proxy-groups"])) {
    config["proxy-groups"] = [];
  }

  // 1. 追加专属 OpenCode 策略组（界面可见、可手动切换节点）
  const existingGroupIndex = config["proxy-groups"].findIndex(
    (g) => g && g.name === OPENCODE_GROUP_NAME
  );

  const allProxies = extractAllProxyNames(config);
  const commonOptions = getCommonGroupOptions(config["proxy-groups"]);

  // 组合策略组选项：支持 DIRECT、常用组（如自动选择）、以及所有节点
  const groupProxies = Array.from(new Set([...commonOptions, ...allProxies]));

  const openCodeGroup = {
    name: OPENCODE_GROUP_NAME,
    type: "select",
    proxies: groupProxies.length > 0 ? groupProxies : ["DIRECT"],
    // Mihomo / Clash.Meta 特性：自动包含所有节点
    "include-all": true,
  };

  // 如果原配置有 proxy-providers，带上 provider 支持
  if (config["proxy-providers"] && typeof config["proxy-providers"] === "object") {
    const providers = Object.keys(config["proxy-providers"]);
    if (providers.length > 0) {
      openCodeGroup.use = providers;
    }
  }

  if (existingGroupIndex >= 0) {
    config["proxy-groups"][existingGroupIndex] = openCodeGroup;
  } else {
    // 插入到首个分组之后（通常第 1 位是 PROXY/节点选择），确保在 FlClash 页面一目了然
    const insertIndex = config["proxy-groups"].length > 0 ? 1 : 0;
    config["proxy-groups"].splice(insertIndex, 0, openCodeGroup);
  }

  // 2. 将 OpenCode 规则追加到 rules 最前方
  const existingRules = new Set(config.rules);
  const rulesToPrepend = OPENCODE_RULES.filter((r) => !existingRules.has(r));
  config.rules = [...rulesToPrepend, ...config.rules];

  console.log(`[FlClash Script] 已追加专属策略组 [${OPENCODE_GROUP_NAME}] 并注入分流规则`);
  return config;
}
