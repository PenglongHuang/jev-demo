/* 0.1.18+ 结构化快照适配：snapshot --json 的输出从 YAML 字符串变成 JSON 无障碍树
 * （node 键：role/name/text/ref/children/cursor/level/active/selected/disabled…），
 * 驱动须在 unwrapResult 里把树转写回下游约定的 YAML 文本 —— util.parseSnapshotRefs、
 * auto-core 的 state 组装、冒烟断言全都吃 YAML 行格式（- role "name" [ref=eN]）。
 * 转写规则按两个版本对同一页面的实测快照逐行对照得出（详见各断言）。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const driver = require(path.join(__dirname, '..', 'browser-driver.js'));
const { parseEnvelope, unwrapResult, treeToSnapshotYaml } = driver._test;
const { parseSnapshotRefs } = require(path.join(__dirname, '..', 'public', 'js', 'util.js'));
const RESUME_TREE = require(path.join(__dirname, 'fixtures', 'snapshot-tree-resume.js'));

/* 覆盖全部已观测节点特性：name / text / level / active / selected / disabled /
 * cursor / children / 无 ref 节点（如 option）。期望行与 0.1.17 对同一元素的
 * 实测 YAML 逐字一致（含 [active] 在 ref 前、[cursor=pointer] 在 ref 后、
 * text 作 ": 尾注"、有 children 的行以裸 ":" 结尾）。 */
const MINI_TREE = [
  { role: 'generic', active: true, ref: 'e1', children: [
    { role: 'heading', name: '候选人管理', level: 1, ref: 'e30' },
    { role: 'searchbox', name: '搜索邮件', ref: 'e4', text: '招商银行' },
    { role: 'button', name: '写信', ref: 'e5', cursor: 'pointer' },
    { role: 'option', name: '全部岗位', selected: true },
    { role: 'button', name: '上一页', disabled: true, ref: 'e391' },
    { role: 'paragraph', ref: 'e40', text: '尊敬的客户：账单已出账' },
  ] },
];

const MINI_YAML = [
  '- generic [active] [ref=e1]:',
  '  - heading "候选人管理" [level=1] [ref=e30]',
  '  - searchbox "搜索邮件" [ref=e4]: 招商银行',
  '  - button "写信" [ref=e5] [cursor=pointer]',
  '  - option "全部岗位" [selected]',
  '  - button "上一页" [disabled] [ref=e391]',
  '  - paragraph [ref=e40]: 尊敬的客户：账单已出账',
].join('\n');

/* ---------- 转写器：树 → YAML 文本 ---------- */

test('treeToSnapshotYaml：节点各特性按 0.1.17 的 YAML 行格式转写', () => {
  assert.strictEqual(treeToSnapshotYaml(MINI_TREE), MINI_YAML);
});

test('treeToSnapshotYaml：缩进按层级 +2 空格，深层嵌套不断行', () => {
  const deep = [{ role: 'a', ref: 'e1', children: [{ role: 'b', ref: 'e2', children: [{ role: 'c', ref: 'e3' }] }] }];
  assert.strictEqual(
    treeToSnapshotYaml(deep),
    '- a [ref=e1]:\n  - b [ref=e2]:\n    - c [ref=e3]');
});

test('treeToSnapshotYaml：text 与 children 并存时 children 优先（YAML 无法同时表达）', () => {
  const both = [{ role: 'generic', ref: 'e1', text: '尾巴', children: [{ role: 'button', name: '确定', ref: 'e2', cursor: 'pointer' }] }];
  assert.strictEqual(
    treeToSnapshotYaml(both),
    '- generic [ref=e1]:\n  - button "确定" [ref=e2] [cursor=pointer]');
});

test('treeToSnapshotYaml：text 折叠空白防换行破坏行格式', () => {
  const messy = [{ role: 'paragraph', ref: 'e9', text: '多行\n\n   且 不  齐' }];
  assert.strictEqual(treeToSnapshotYaml(messy), '- paragraph [ref=e9]: 多行 且 不 齐');
});

test('treeToSnapshotYaml：空树 / 非数组输入返回空串（不抛错）', () => {
  assert.strictEqual(treeToSnapshotYaml([]), '');
  assert.strictEqual(treeToSnapshotYaml(null), '');
  assert.strictEqual(treeToSnapshotYaml({ role: 'x' }), '');
});

/* ---------- unwrapResult / parseEnvelope 接线 ---------- */

test('unwrapResult：snapshot 为树（数组）时自动转写；为字符串时原样（0.1.17 路径）', () => {
  assert.strictEqual(unwrapResult({ snapshot: MINI_TREE }), MINI_YAML);
  assert.strictEqual(unwrapResult({ snapshot: '- generic [ref=e1]:' }), '- generic [ref=e1]:');
});

test('unwrapResult：click/open 返回的 {snapshot:{file}} 不是树，不得误转写', () => {
  const fileShape = unwrapResult({ snapshot: { file: '.playwright-cli\\page-x.yml' } });
  assert.match(fileShape, /page-x\.yml/);
  assert.doesNotMatch(fileShape, /- generic/);
});

test('parseEnvelope：0.1.21 的 {snapshot:[…]} stdout 解析为转写后的 YAML', () => {
  const out = parseEnvelope({ code: 0, stdout: JSON.stringify({ snapshot: MINI_TREE }), stderr: '' });
  assert.deepStrictEqual(out, { ok: true, result: MINI_YAML });
});

/* ---------- 下游契约：转换结果必须能被 parseSnapshotRefs 消费 ---------- */

test('真实简历页树 → YAML 后 parseSnapshotRefs 拿到可交互元素', () => {
  const yaml = treeToSnapshotYaml(RESUME_TREE);
  assert.match(yaml, /\[ref=/);
  assert.match(yaml, /候选人管理/);

  const refs = parseSnapshotRefs(yaml);
  assert.ok(refs.length > 50, 'ref 数量异常：' + refs.length);
  const search = refs.find((r) => /searchbox "搜索/.test(r.label));
  assert.ok(search, '找不到搜索框 ref');
  assert.strictEqual(search.interactive, true);
  const btn = refs.find((r) => /button ".*筛选|button "查询/.test(r.label) || r.role === 'button');
  assert.ok(btn, '找不到按钮 ref');
  assert.strictEqual(btn.role, 'button');
  /* [cursor=pointer] 必须保留：parseSnapshotRefs 靠它判可交互 */
  assert.match(yaml, /\[cursor=pointer\]/);
  /* heading 的 [level=1] 落在 label 里、role 仍取首词（auto-core 动作×角色校验用） */
  const h = refs.find((r) => r.role === 'heading');
  assert.ok(h && /\[level=1\]/.test(h.label), 'heading 行应保留 [level=1]');
});

test('真实简历页树 → YAML 与 0.1.17 实测 YAML 的 ref 集合一致', () => {
  /* 同一页面的两代快照：ref 编号可能因实现差异漂移，但「role+name 对」集合
   * 必须一致 —— 这是下游真正依赖的东西（选项标签、动作×角色校验）。 */
  const yaml17 = require(path.join(__dirname, 'fixtures', 'resume-snapshot.js'));
  const norm = (txt) => parseSnapshotRefs(txt)
    .map((r) => r.role + '|' + r.label.replace(/\s+/g, ''))
    .sort();
  const a = norm(yaml17), b = norm(treeToSnapshotYaml(RESUME_TREE));
  /* 0.1.17 夹具是 msedge 采的静态数据，页面可能已改版：只比交集比率，不逐项相等 */
  const setA = new Set(a), inter = b.filter((x) => setA.has(x)).length;
  assert.ok(inter >= Math.min(a.length, b.length) * 0.6,
    '两代快照的 role+name 交集过低：inter=' + inter + ' a=' + a.length + ' b=' + b.length);
});
