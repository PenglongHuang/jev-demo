/* 动作之后的快照（「直接顶替下一步的 snapshot」）——单元测试，不起浏览器。
 *
 * 背景（2026-09-29 实测 + 读 playwright-core coreBundle 源码核实）：
 *   · playwright-cli 的部分动作会在 --json 结果里附一份「动作之后」的快照工件
 *     （{snapshot:{file:'.playwright-cli\\page-<ISO>.yml'}}），上游的 click/hover 等
 *     handle 就是 setIncludeSnapshot() + await waitForCompletion()（动作后固定 500ms、
 *     再等动作期间发出的请求完成，导航则等 load），快照在响应序列化时才取。
 *   · 但**不是每个动作都有**：click / hover / select / uncheck / goto / reload / go-back /
 *     go-forward / upload / tab-new(带 url) / press(仅 Enter) 有；fill / check / 非 Enter 的
 *     press / tab-list 没有（browser_type 只在 pressSequentially 分支才 setIncludeSnapshot）。
 *   · 我们自己的 CDP 快路径走 run-code，绕开 CLI 的动作命令 —— 那里一条工件都不会有，
 *     所以这条命令里要自己把「等稳定 + 取快照」做掉（page.ariaSnapshot({mode:'ai'})，
 *     与 CLI 的 snapshot 命令实测逐字节一致）。
 *
 * 这些测试盯的就是上面三条的地基：路径认领、沙箱读回、形状转写、「能不能用」的判定，
 * 以及生成出来的那条合并命令里 settle 与取快照的位置关系。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const driver = require(path.join(__dirname, '..', 'browser-driver.js'));
const {
  parseEnvelope, snapshotArtifactRel, artifactAbsPath, readArtifactSnapshot, discardArtifact,
  normalizeArtifactText, usableSnapshot, mergedActCode, treeToSnapshotYaml,
  ACTION_TIMEOUT_MS, ACT_FAST_TIMEOUT_MS, SETTLE_MS, SETTLE_REQ_CAP_MS, SETTLE_NAV_MS, SNAPSHOT_CAP_MS,
} = driver._test;

/* ---------- 工件路径的认领 ---------- */

test('snapshotArtifactRel：认得 click 那种顶层 {snapshot:{file}} 与 open 那种嵌在 result 里的', () => {
  assert.strictEqual(snapshotArtifactRel({ snapshot: { file: '.playwright-cli\\page-a.yml' } }), '.playwright-cli\\page-a.yml');
  assert.strictEqual(snapshotArtifactRel({ result: { snapshot: { file: '.playwright-cli\\page-b.yml' } } }), '.playwright-cli\\page-b.yml');
});

test('snapshotArtifactRel：快照**文本**与结构化树都不算工件（那是两种不同形状）', () => {
  assert.strictEqual(snapshotArtifactRel({ snapshot: '- generic [ref=e1]' }), null, '文本快照不是工件路径');
  assert.strictEqual(snapshotArtifactRel({ snapshot: [{ role: 'generic', ref: 'e1' }] }), null, '结构化树不是工件路径');
  assert.strictEqual(snapshotArtifactRel({ result: 'ok' }), null);
  assert.strictEqual(snapshotArtifactRel({}), null);
  assert.strictEqual(snapshotArtifactRel(null), null);
  assert.strictEqual(snapshotArtifactRel({ snapshot: { file: '' } }), null, '空路径不算');
  assert.strictEqual(snapshotArtifactRel({ snapshot: { file: 42 } }), null, '非字符串不算');
});

test('parseEnvelope：工件路径带出来，同时 result 仍是文本（不破坏既有形状）', () => {
  const click = parseEnvelope({ code: 0, stdout: JSON.stringify({ snapshot: { file: '.playwright-cli\\page-a.yml' } }), stderr: '' });
  assert.strictEqual(click.ok, true);
  assert.strictEqual(click.artifact, '.playwright-cli\\page-a.yml');
  assert.strictEqual(typeof click.result, 'string', 'result 仍是字符串（既有契约）');
  assert.doesNotMatch(click.result, /- generic/, '工件路径绝不能被当成树转写');

  const open = parseEnvelope({ code: 0, stdout: JSON.stringify({ result: { snapshot: { file: 'x.yml' } } }), stderr: '' });
  assert.strictEqual(open.artifact, 'x.yml');

  const plain = parseEnvelope({ code: 0, stdout: JSON.stringify({ result: 'done' }), stderr: '' });
  assert.strictEqual(plain.artifact, undefined, '没有工件的命令不许多出一个字段');
});

test('parseEnvelope：**失败**的动作也要把工件路径带出来（否则那份文件永远没人删）', () => {
  const bad = parseEnvelope({ code: 0, stdout: JSON.stringify({ isError: true, error: 'Error: boom', snapshot: { file: '.playwright-cli\\page-bad.yml' } }), stderr: '' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.artifact, '.playwright-cli\\page-bad.yml', '失败分支同样要认领：CLI 的 Error 段与 Snapshot 段并不互斥');
  const badNoFile = parseEnvelope({ code: 0, stdout: JSON.stringify({ isError: true, error: 'Error: boom' }), stderr: '' });
  assert.strictEqual(badNoFile.artifact, undefined);
});

/* ---------- 沙箱：读回与丢弃 ---------- */

test('discardArtifact：只删 data/ 内的文件，出格的一律不碰', () => {
  withTempDataDir((root) => {
    const dir = path.join(root, '.playwright-cli');
    fs.mkdirSync(dir, { recursive: true });
    const inside = path.join(dir, 'page-x.yml');
    fs.writeFileSync(inside, '- generic [ref=e1]\n', 'utf8');
    assert.strictEqual(discardArtifact('.playwright-cli\\page-x.yml'), true, 'data/ 内：删');
    assert.strictEqual(fs.existsSync(inside), false);

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-outside2-'));
    const outside = path.join(out, 'outside.yml');
    fs.writeFileSync(outside, 'x', 'utf8');
    assert.strictEqual(discardArtifact(outside), false, 'data/ 外：不删');
    assert.strictEqual(fs.existsSync(outside), true, '绝对不能删到外面的文件');
    assert.strictEqual(discardArtifact(null), false);
    assert.strictEqual(discardArtifact(''), false);
  });
});

test('artifactAbsPath：与读回/丢弃共用同一套沙箱判定', () => {
  withTempDataDir((root) => {
    assert.ok(artifactAbsPath('.playwright-cli\\page-a.yml').startsWith(path.resolve(root)));
    assert.strictEqual(artifactAbsPath('../escape.yml'), null);
    assert.strictEqual(artifactAbsPath('file:///C:/x'), null);
  });
});

/* ---------- 沙箱读回 ---------- */

function withTempDataDir(fn) {
  const prev = driver.dataDir;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-artifact-'));
  driver.dataDir = root;
  try { return fn(root); } finally { driver.dataDir = prev; }
}

test('readArtifactSnapshot：读得到、读完即删（每个动作一个文件，不删会无限堆积）', () => {
  withTempDataDir((root) => {
    const dir = path.join(root, '.playwright-cli');
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, 'page-a.yml');
    fs.writeFileSync(abs, '- generic [ref=e1]:\n  - button "go" [ref=e2]\n', 'utf8');

    const text = readArtifactSnapshot('.playwright-cli\\page-a.yml');
    assert.match(text, /\[ref=e2\]/, '拿到的就是那一页的快照');
    assert.strictEqual(fs.existsSync(abs), false, '读完必须删掉');
  });
});

test('readArtifactSnapshot：读不到 / 路径出格一律 null（调用方据此真取一次，不拿半截文本当快照）', () => {
  withTempDataDir((root) => {
    /* data/ 的**兄弟**文件：正是「越出沙箱」那一类（绝对路径与相对路径两条路都要拒） */
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-outside-'));
    const outside = path.join(out, 'outside.yml');
    fs.writeFileSync(outside, '- generic [ref=e1]\n', 'utf8');
    assert.strictEqual(readArtifactSnapshot('.playwright-cli\\missing.yml'), null, '文件不在');
    assert.strictEqual(readArtifactSnapshot(''), null);
    assert.strictEqual(readArtifactSnapshot(null), null);
    assert.strictEqual(readArtifactSnapshot(outside), null, '绝对路径在 data/ 之外 → 拒');
    assert.strictEqual(readArtifactSnapshot(path.relative(path.resolve(root), outside)), null, '相对路径绕出 data/ → 拒');
    assert.strictEqual(readArtifactSnapshot('file:///C:/Windows/win.ini'), null, 'URL 形态 → 拒');
    assert.strictEqual(fs.existsSync(outside), true, '拒掉的那些不能被读、更不能被删');
  });
});

test('readArtifactSnapshot：空文件 / 认不出的 JSON 一律 null（宁可多跑一次快照，不可喂空页面）', () => {
  withTempDataDir((root) => {
    const dir = path.join(root, '.playwright-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'empty.yml'), '   \n', 'utf8');
    fs.writeFileSync(path.join(dir, 'obj.yml'), JSON.stringify({ role: 'generic' }), 'utf8');
    assert.strictEqual(readArtifactSnapshot('.playwright-cli\\empty.yml'), null);
    assert.strictEqual(readArtifactSnapshot('.playwright-cli\\obj.yml'), null, '不是数组形状的结构化树不认');
  });
});

test('normalizeArtifactText：0.1.18+ 若把工件写成 JSON 树，按已有转写器变成 YAML 行', () => {
  const tree = [{ role: 'generic', ref: 'e1', children: [{ role: 'button', name: 'go', ref: 'e2', cursor: 'pointer' }] }];
  const yaml = normalizeArtifactText(JSON.stringify(tree));
  assert.match(yaml, /- generic \[ref=e1\]:/);
  assert.match(yaml, /- button "go" \[ref=e2\] \[cursor=pointer\]/);
  assert.strictEqual(yaml.trim(), treeToSnapshotYaml(tree).trim(), '与既有转写器同一份规则');

  /* 0.1.17 的工件就是文本：原样通过，不做任何加工 */
  const text = '- generic [ref=e1]:\n  - button "go" [ref=e2]\n';
  assert.strictEqual(normalizeArtifactText(text), text.trim());
  assert.strictEqual(normalizeArtifactText(''), null);
});

/* ---------- 「能不能当下一步依据用」的判定 ---------- */

test('usableSnapshot：非空**且带 ref** 才算数 —— 下游全按 ref 行解析', () => {
  const ok = '- generic [ref=e1]:\n  - button "go" [ref=e2]\n';
  assert.strictEqual(usableSnapshot(ok), ok);
  assert.strictEqual(usableSnapshot('- generic:\n  - heading "x"'), null, '无 ref 的文本等于空页面');
  assert.strictEqual(usableSnapshot(''), null);
  assert.strictEqual(usableSnapshot('   '), null);
  assert.strictEqual(usableSnapshot(null), null);
  assert.strictEqual(usableSnapshot(undefined), null);
  assert.strictEqual(usableSnapshot(['- generic [ref=e1]']), null, '数组不是文本');
});

/* ---------- CDP 快路径：合并命令里自行「等稳定 + 取快照」 ---------- */

test('mergedActCode：动作之后自己等稳定、自己取快照，并把它交回去', () => {
  const code = mergedActCode('jevtab-fp-1', 'click', 'e12', '');
  assert.match(code, /page\.on\('request'/, '动作之前挂上请求监听');
  assert.match(code, /page\.off\('request'/, '动作之后摘掉');
  assert.match(code, /page\.ariaSnapshot\(\{ mode: 'ai' \}\)/, '取的就是 CLI snapshot 用的同一次调用');
  assert.match(code, /page\.waitForTimeout\(500\)/, '动作后先给固定静默期');
  assert.match(code, /page\.mainFrame\(\)\.waitForLoadState\('load'/, '触发导航则等 load');
  assert.match(code, /return \{ actError: __err, snapshot: __snap \}/, '快照随返回值交回');
  assert.match(code, /if \(!__err\) \{/, '动作失败就不取快照（失败步保持原样）');
});

test('mergedActCode：请求监听在动作之前、settle 之后才摘（摘早了会漏掉静默期里发出的请求）', () => {
  const code = mergedActCode('jevtab-fp-1', 'click', 'e12', '');
  const iOn = code.indexOf("page.on('request'");
  const iAct = code.indexOf('__loc.click(');
  const iWait = code.indexOf('waitForTimeout(500)');
  const iSnap = code.indexOf('ariaSnapshot(');
  const iOff = code.indexOf("page.off('request'");
  const iRet = code.indexOf('return { actError');
  assert.ok(iOn >= 0 && iAct >= 0 && iWait >= 0 && iSnap >= 0 && iOff >= 0 && iRet >= 0);
  assert.ok(iOn < iAct, '监听必须在动作之前挂（要等的正是这个动作引出的请求）');
  /* 上游是「动作 → waitForTimeout(500) → finally dispose」：静默期内才发出的请求
   * （debounce 的 fetch、链式请求）同样算这个动作引出来的，摘早了就不会等它们。 */
  assert.ok(iAct < iWait && iWait < iOff, '500ms 静默期必须在摘监听之前等完');
  assert.ok(iSnap < iOff, '取快照也在摘监听之前');
  assert.ok(iOff < iRet, '摘监听必须在 return 之前：失败路径（不 settle）同样要摘干净');
});

test('mergedActCode：取快照自己跟超时赛跑（弹窗挂着时上游有 race，我们没有）', () => {
  const code = mergedActCode('jevtab-fp-1', 'click', 'e12', '');
  assert.match(code, /Promise\.race\(\[/, '取快照不能是一个裸 await —— 挂住就再也没人管');
  assert.match(code, /page\.waitForTimeout\(10000\)\.then\(\(\) => null\)/, '超时当作没取到，交给下一步真取');
});

test('mergedActCode：新增片段没带进 cmd 引号禁字，也没带 setTimeout（run-code 里没有它）', () => {
  for (const op of ['click', 'fill', 'hover', 'check', 'uncheck']) {
    const code = mergedActCode('jevtab-fp-1', op, 'e12', op === 'fill' ? '文本' : '');
    /* 与既有断言同一条规矩：代码是落文件传给 CLI 的（不经 cmd 引号），换行是代码文件
     * 天然有的；只禁双引号与百分号。 */
    assert.doesNotMatch(code, /["%]/, op + ' 的合并片段必须能安全通过 cmd 引号封装');
    assert.doesNotMatch(code, /setTimeout\(/, op + '：run-code 的函数不在 Node 作用域里求值，没有 setTimeout');
    assert.match(code, /aria-ref=e12/, op + '：定位方式不变');
    assert.doesNotMatch(code, /force/, op + '：不许用 force 绕过可操作性判定');
  }
});

test('快路径的子进程超时必须盖得住这条命令里所有的等待段（少算哪段都是「动作成了却报超时」）', () => {
  const settleWorstMs = SETTLE_MS * 2 + SETTLE_REQ_CAP_MS + SETTLE_NAV_MS;
  assert.ok(ACT_FAST_TIMEOUT_MS >= ACTION_TIMEOUT_MS + settleWorstMs + SNAPSHOT_CAP_MS,
    'ACT_FAST_TIMEOUT_MS(' + ACT_FAST_TIMEOUT_MS + ') 要盖住 动作预算 + settle(' + settleWorstMs + ') + 取快照上限(' + SNAPSHOT_CAP_MS + ')');
});
