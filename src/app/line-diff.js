/**
 * 行级 diff。无依赖，可脱离 DOM 单独测试。
 *
 * 用 LCS 动态规划而不是 Myers：单次改写的行数通常几十行，
 * O(n*m) 完全够用，而 Myers 的代码量是三倍，在这里换不到收益。
 * 空间用 Uint16Array，行数上万时也只有 (n+1)*(m+1)*2 字节。
 */

/**
 * @param {string[]} a 原行
 * @param {string[]} b 新行
 * @returns {Array<{type:'same'|'add'|'del', text:string, aIdx?:number, bIdx?:number}>}
 */
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i], aIdx: i });
      i++;
    } else {
      out.push({ type: 'add', text: b[j], bIdx: j });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++], aIdx: i - 1 });
  while (j < m) out.push({ type: 'add', text: b[j++], bIdx: j - 1 });
  return out;
}

/** 统计增删行数 */
export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
  }
  return { added, removed };
}

/**
 * 判断差异是否只是末尾空行。
 *
 * LCS 在「原文无尾换行、新文有」这种情形下会记一条 add（text 为空串），
 * 反之记一条 del。界面上那只是一行空白，用户既看不出改了什么，
 * 也无从判断该不该接受，所以面板把这类改动视作「无有效变化」。
 *
 * 判定要严格：只要存在任何一条非空内容的 add/del，就不算。
 *
 * @param {Array} rows diffLines() 的结果
 * @returns {boolean}
 */
export function onlyTrailingBlankChange(rows) {
  let hasChange = false;
  for (const r of rows) {
    if (r.type === 'same') continue;
    hasChange = true;
    if (r.text.trim() !== '') return false;
  }
  return hasChange;
}
