/* ===================== playwright-cli 工具列表 =====================
 * 「下一步动作」的候选集合。按官方命令集整理，覆盖导航 / 交互 / 键盘鼠标 /
 * 检查 / 标签页 / 弹窗 / 存储 / 网络 / 调试 / 视口 / 终止态。
 */
const PLAYWRIGHT_TOOLS = {
  'click': '点击某个元素（需配合 参数 指定 ref）',
  'dblclick': '双击某个元素',
  'fill': '清空并填入文本到输入框 / 文本域',
  'type': '在当前焦点处逐字输入文本',
  'press': '按下一个按键，如 Enter、Escape、ArrowDown',
  'keydown': '按住某个修饰键不放，如 Shift、Control',
  'keyup': '松开之前按住的修饰键',
  'select': '在下拉框中选择某个选项',
  'check': '勾选复选框或单选框',
  'uncheck': '取消勾选复选框',
  'hover': '将鼠标悬停在某个元素上',
  'drag': '把某个元素拖拽到另一个元素',
  'upload': '上传本地文件到文件选择控件',
  'mousemove': '把鼠标移动到指定坐标',
  'mousedown': '在当前位置按下鼠标按键',
  'mouseup': '在当前位置松开鼠标按键',
  'mousewheel': '滚动鼠标滚轮',
  'goto': '导航到指定的新网址',
  'go-back': '浏览器后退到上一页',
  'go-forward': '浏览器前进到下一页',
  'reload': '重新加载当前页面',
  'open': '打开一个新的浏览器会话',
  'close': '关闭当前浏览器会话',
  'snapshot': '获取当前页面的可访问性快照，用于拿到最新 ref',
  'screenshot': '对页面或指定元素截图',
  'pdf': '把当前页面导出为 PDF',
  'eval': '在页面中执行一段 JavaScript 表达式并取回结果',
  'console': '查看浏览器控制台日志',
  'network': '查看网络请求记录',
  'tab-new': '新开一个标签页',
  'tab-select': '切换到指定标签页',
  'tab-close': '关闭指定标签页',
  'tab-list': '列出当前所有标签页',
  'dialog-accept': '接受浏览器弹窗（alert / confirm）',
  'dialog-dismiss': '关闭或取消浏览器弹窗',
  'resize': '调整浏览器视口尺寸',
  'cookie-list': '列出当前站点的 Cookie',
  'cookie-get': '读取指定 Cookie 的值',
  'cookie-set': '写入一个 Cookie',
  'cookie-delete': '删除指定 Cookie',
  'localstorage-list': '列出 localStorage 的全部键值',
  'localstorage-get': '读取 localStorage 中某个键',
  'localstorage-set': '写入 localStorage 中某个键',
  'sessionstorage-list': '列出 sessionStorage 的全部键值',
  'sessionstorage-get': '读取 sessionStorage 中某个键',
  'sessionstorage-set': '写入 sessionStorage 中某个键',
  'state-save': '把登录态（Cookie 与存储）保存到文件',
  'state-load': '从文件恢复之前保存的登录态',
  'route': '拦截并改写某个网络请求的响应',
  'unroute': '取消之前设置的请求拦截',
  'run-code': '执行一段 Playwright 脚本以完成复杂操作',
  'tracing-start': '开始记录操作追踪',
  'tracing-stop': '结束记录操作追踪',
  'video-start': '开始录制操作视频',
  'video-stop': '结束录制操作视频',
  '任务已完成': '目标已经达成，不需要再执行任何浏览器操作'
};

/* ===================== 大型快照生成器 =====================
 * 生成一个 ~15K token 级别的电商后台订单页可访问性快照：
 * 导航 + 筛选区 + 15 笔订单（每笔 7 个 ref）+ 分页，ref 总数 132（choice 上限 255）。
 * 行内长文本（地址 / SKU / 买家留言 / 物流备注）撑起体积，结构真实、完全确定性可复现。
 */
function buildMallSnapshot() {
  const BUYERS = ['王小明', '李婷婷', '张伟', '陈思远', '刘雨欣', '赵强', '孙丽华', '周子航', '吴敏', '郑小龙',
    '冯雪', '蒋文明', '韩梅', '唐悦', '曹志强'];
  const CITIES = ['北京市朝阳区望京街道方恒国际中心 B 座 12 层 1201 室（前台代收，工作日 9:00-18:00 有人）',
    '上海市浦东新区世纪大道 100 号环球金融中心 56 楼市场部（周末无人，请约工作日白天）',
    '广州市天河区珠江新城华夏路 10 号富力中心 21 层 2107 室（需走访客登记，提前电话联系）',
    '深圳市南山区科技园南区深南大道 9988 号 5 栋 802（老旧小区无电梯，请安排青壮年配送员）',
    '杭州市西湖区文三路 478 号华星世纪大厦 6 层 618 室（大厦快递统一放 1 层收发室）',
    '成都市武侯区天府大道北段 1700 号环球中心 N2 区 11 层 1136 室（大厦中央空调 18:30 关闭）',
    '武汉市洪山区光谷步行街世界城广场 35 层 3502 室（写字楼需刷身份证上楼）',
    '南京市鼓楼区中山北路 30 号城市名人广场 2 幢 1808 室（门禁坏了，到楼下打电话有人开门）',
    '西安市雁塔区高新路 25 号世纪大厦 1808 室（工作日家里有人，老人腿脚不便请送上门）',
    '重庆市渝北区新南路 166 号 2 幢 1 单元 22 楼 4 号（小区门在南门，导航请定位南门）'];
  const GOODS = [
    'Apple/苹果 AirPods Pro 2 (USB-C) 主动降噪无线蓝牙耳机 国行正品 全国联保',
    '华为 FreeBuds Pro 3 真无线降噪耳机 星闪连接版 曜金黑 官方标配',
    '小米 Buds 4 Pro 主动降噪无线耳机 48dB 深降噪 星耀金 限量礼盒装',
    '索尼 WH-1000XM5 头戴式无线降噪耳机 铂金银 含原厂收纳包',
    '三星 Galaxy Buds3 Pro 智能主动降噪 耳机 银色 支持实时翻译',
    'OPPO Enco X3 丹拿联合调音真无线降噪耳机 云波蓝 双设备同时连接',
    'vivo TWS 4 高保真真无线蓝牙耳机 星际蓝 深空降噪',
    '荣耀 Earbuds 3 Pro 超宽频同轴双单元 降噪耳机 曜石黑'
  ];
  const NOTES = [
    '麻烦发货前发消息和我确认一下颜色还有没有货，我下午 6 点以后才下班到家，快递直接放门口快递柜就行，谢谢师傅了，麻烦了。',
    '收货地址写的是公司，周末没人签收，请尽量安排工作日白天派送；如果电话一时无法接通，请先派给一楼前台代收并拍照留底。',
    '这一单是送人的生日礼物，麻烦帮忙用礼盒包装一下，外面不要贴任何价格标签和商品明细，包装盒也请不要打胶带，非常感谢。',
    '上次在同一家店买过同款，左耳有电流声，这次收到货请先帮我试一下左右耳再发出来，如果还有问题直接联系我换货，拜托了。',
    '我 25 号一早要出差，25 号之前一定要送到；如果物流来不及，请提前打电话跟我商量是不是改寄到我公司地址，谢谢。',
    '发票抬头开公司名称，电子发票即可，抬头：某某（上海）网络科技有限公司；税号我稍后私信发你，请勿随包裹寄纸质发票。',
    '备注一下：商品如有任何瑕疵直接给我退货退款就好，不需要换货了，运费险我已经买好了，你们尽管放心发出，不用电话确认。',
    '家里装修刚完快递柜还没通电，麻烦派送前打我电话，我下楼来取；中午 12 点到 14 点我在午休，请尽量避开这个时间段。'
  ];
  const LOGIS = [
    '冷链专线：该区域默认走顺丰特快，预计 48 小时内送达；如遇大促爆仓自动改走京东标快，延迟不再额外通知买家。',
    '此地址为乡镇代理点，需凭短信取件码自提；站点电话已短信告知买家，超过 3 天未取件包裹将原路退回中心仓并记异常。',
    '内含锂电池，民航禁运，全程陆运；江浙沪隔日达，京津冀鲁三日达，偏远地区在标准时效上再加 2-3 个工作日。',
    '易碎品，仓库已做六面加固；中转交接时需拍照留底，签收异常第一时间联系客服改派，勿直接放代收点。',
    '该买家历史有 1 次拒签记录，派送前务必电话确认收货意愿；若再次拒签，包裹直接转入逆向仓做质检入库处理。',
    '大件商品走货运专线送装一体，上楼费已在线支付；请提前 2 小时电话预约，老旧小区无电梯需安排两名配送员。'
  ];
  const SRVS = [
    '2026-09-19 买家发起价保申请，客服已核实差价 60 元，预计 T+3 原路退回支付账户。',
    '2026-09-18 买家来电咨询保修政策，客服已发送电子保修卡并说明：主机一年、电池半年。',
    '2026-09-17 系统检测收货地址与下单常用地不一致，已触发风控人工复核，复核通过后自动放行。',
    '2026-09-15 买家申请修改收货地址，仓库已在拣货前同步新地址，无需拦截重派。',
    '2026-09-14 该买家为本店回头客第 5 次下单，已自动升级为优先发货，仓内时效提升至 6 小时。'
  ];
  const PAYS = ['微信支付', '支付宝', '云闪付', '花呗分期（3 期）', ' Apple Pay'];

  const lines = [];
  let eNo = 0;
  const ref = () => 'e' + (++eNo);
  const orderNo = (i) => 'ORD-202609' + String(22 - Math.floor(i / 5)).padStart(2, '0') + '-' + String(4821 + i * 7).padStart(4, '0');

  lines.push('- generic [active] [ref=' + ref() + ']:');
  lines.push('  - banner [ref=' + ref() + ']:');
  ['首页', '订单中心', '商品管理', '客服工作台', '数据报表'].forEach((t) => {
    lines.push('    - link "' + t + '" [ref=' + ref() + '] [cursor=pointer]:');
    lines.push('      - /url: /admin/' + t);
  });
  lines.push('    - img "管理员头像" [ref=' + ref() + ']');
  lines.push('    - button "退出登录" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('  - main [ref=' + ref() + ']:');
  lines.push('    - heading "订单管理" [level=1] [ref=' + ref() + ']');
  lines.push('    - searchbox "搜索订单号 / 买家昵称 / 收件人手机号" [ref=' + ref() + ']');
  lines.push('    - combobox "订单状态" [ref=' + ref() + ']:');
  ['全部状态', '已付款待发货', '退款/售后'].forEach((o) => lines.push('      - option "' + o + '" [ref=' + ref() + ']'));
  lines.push('    - combobox "支付方式" [ref=' + ref() + ']');
  lines.push('    - textbox "开始日期" [ref=' + ref() + ']');
  lines.push('    - textbox "结束日期" [ref=' + ref() + ']');
  lines.push('    - button "查询" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - button "重置" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - table "订单列表（默认展示最近 15 笔）" [ref=' + ref() + ']:');

  const ROWS = 15;
  const TARGET = 9; // 第 10 行：AirPods 且「已付款待发货」→ 全表唯一可发货目标
  for (let i = 0; i < ROWS; i++) {
    const no = orderNo(i);
    const status = (i % 4 === 0) ? '待付款' : (i % 4 === 1) ? '已付款待发货' : (i % 4 === 2) ? '已发货' : '退款/售后';
    const goods = (i === TARGET) ? GOODS[0] : GOODS[1 + (i % (GOODS.length - 1))];
    const isTarget = i === TARGET;

    lines.push('      - row "订单 ' + no + '":');
    lines.push('        - cell "' + no + '":');
    lines.push('          - link "' + no + '" [ref=' + ref() + '] [cursor=pointer]:');
    lines.push('            - /url: /admin/orders/' + no);
    lines.push('        - cell "' + BUYERS[i] + ' · ' + CITIES[i % CITIES.length] + ' · 收件电话 138****' + String(1000 + i * 37).slice(0, 4) + '" [ref=' + ref() + ']');
    lines.push('        - cell "' + goods + '" [ref=' + ref() + ']');
    lines.push('        - text: SKU 明细：颜色 ' + ['曜金黑', '星光白', '深空灰', '铂金银', '云波蓝'][i % 5] + '；版本 ' + ['国行', '港版', '海外版'][i % 3] + '；保修 ' + ['一年整机', '半年电池', '两年碎屏宝'][i % 3] + '；赠品 ' + ['原厂保护壳', '收纳包', '耳帽两副', '贴膜服务'][i % 4] + '；序列号 SN' + String(88400 + i * 13) + ' 已录入售后系统');
    lines.push('        - text: 买家留言：' + NOTES[i % NOTES.length]);
    lines.push('        - text: 商家备注：' + (i % 2 === 0 ? '高价值订单，出库前请二次质检并录像；' : '') + '随单附赠手写感谢卡一张，由打包组负责放入。');
    lines.push('        - text: 物流备注：' + LOGIS[i % LOGIS.length]);
    lines.push('        - text: 支付流水：' + PAYS[i % PAYS.length] + ' 交易号 ' + (910000000 + i * 13337) + String(i).padStart(2, '0') + '，实付 ¥' + (899 + i * 37) + '.00，运费 ¥0.00，优惠 -¥' + (i * 11) + '.00，积分抵扣 ' + (i * 15) + ' 分。');
    lines.push('        - text: 出库记录：波次 WF-' + (3300 + i) + ' 于 ' + ['09-22 08:41', '09-22 09:02', '09-22 09:17', '09-21 22:48', '09-22 10:05'][i % 5] + ' 完成拣货，复核员 ' + ['A037', 'B112', 'C058', 'D093', 'E021'][i % 5] + '，称重 ' + (220 + i * 9) + 'g，包裹体积 24×18×9cm，已贴面单 ' + ['SF', 'JD', 'YTO', 'ZTO', 'EMS'][i % 5] + '-' + String(770100 + i * 29) + '。');
    lines.push('        - text: 售后记录：' + SRVS[i % SRVS.length]);
    lines.push('        - text: 合规检查：收货人实名信息已通过 ' + ['一要素', '二要素', '三要素'][i % 3] + '核验；' + (i % 3 === 0 ? '订单金额超 1500 元，已触发反洗钱人工复核并留痕；' : '') + '商品经品牌方授权渠道采购，授权书编号 BR-' + (20250 + i) + ' 在有效期内。');
    lines.push('        - generic "' + status + '" [ref=' + ref() + ']');
    lines.push('        - button "查看" [ref=' + ref() + '] [cursor=pointer]');
    lines.push('        - button "编辑" [ref=' + ref() + '] [cursor=pointer]');
    lines.push('        - button "' + (isTarget ? '发货' : (status === '待付款' ? '去收款' : '售后')) + '" [ref=' + ref() + '] [cursor=pointer]');
  }

  lines.push('    - navigation "分页" [ref=' + ref() + ']:');
  lines.push('      - button "上一页" [ref=' + ref() + '] [disabled]');
  lines.push('      - text: 第 1 / 6 页 · 共 189 笔订单');
  lines.push('      - button "下一页" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('      - link "跳转到末页" [ref=' + ref() + '] [cursor=pointer]:');
  lines.push('        - /url: /admin/orders?page=6');
  lines.push('  - contentinfo [ref=' + ref() + ']:');
  lines.push('    - text: © 2026 云上书城订单中台 · 内部系统请勿外传');

  return lines.join('\n');
}

/* ===================== 邮箱收件箱快照生成器 =====================
 * 收件箱：顶栏 + 文件夹导航 + 筛选工具条 + 18 封邮件（每封 8-9 个 ref），
 * ref 总数约 176。强混淆点：同一发件人（招商银行信用卡中心）有三封相似邮件、
 * 主题几乎相同（9 月 / 8 月对账单）、每行一个同名「归档」按钮、银行通知与广告混排。
 * 唯一目标：第 1 封 —— 招商银行信用卡中心 + 9 月电子对账单 + 时间最新。
 */
function buildMailboxSnapshot() {
  const MAILS = [
    { from: '招商银行信用卡中心', subject: '您的 9 月电子对账单已生成', att: true, star: true, time: '09-23 08:12',
      snippet: '尊敬的客户：您名下尾号 6688 的信用卡 2026 年 9 月账单已出账，本期账单金额 ¥3,412.50，最低还款额 ¥341.30，到期还款日 10 月 12 日。可登录掌上生活 App 查看完整明细，或通过附件下载 PDF 对账单留存。' },
    { from: '李婉宁', subject: 'Re: 周五评审会材料确认', time: '09-23 07:45',
      snippet: '大家好，评审材料我已经更新到共享盘，主要改动是风控模块的时序图和灰度计划的资源评估。周五上午十点开始，请各位提前过一遍，有问题的部分在文档评论区留言，会上统一讨论。' },
    { from: '招商银行储蓄卡', subject: '账户余额变动提醒（支出 ¥1,280.00）', time: '09-22 21:30',
      snippet: '您的账户 6225****8876 于 09-22 21:29 完成一笔快捷支付交易，金额人民币 1,280.00 元，对方商户为顺丰速运。可用余额 ¥46,215.80。如非本人操作，请立即致电客服热线挂失冻结。' },
    { from: '周航', subject: '项目周报 W38：风控模块联调完成', time: '09-22 18:02',
      snippet: '本周重点：风控规则引擎联调完成，接口平均耗时 42ms，比预期好；遗留问题是对账批处理的慢查询还需要优化，预计下周二之前完成。附件是周报原文和燃尽图，请查阅。' },
    { from: '灵犀云市场', subject: '限时优惠：云服务器 3 折起，错过再等一年', time: '09-22 16:40',
      snippet: '年度大促最后 3 天！2 核 4G 云服务器首年仅需 ¥198，企业新用户再享满减礼包。活动名额有限，点击进入活动页立即抢购，退还规则以活动页说明为准。' },
    { from: '招商银行信用卡中心', subject: '还款成功通知（卡号 6225****6688）', time: '09-22 14:18',
      snippet: '您的信用卡于 09-22 14:17 入账一笔还款，金额人民币 2,000.00 元，当前剩余应还金额 ¥1,412.50。感谢您的按时还款，继续保持良好的用卡记录有助于额度提升。' },
    { from: '王倩', subject: '合同盖章流程卡住了，帮忙看下', star: true, time: '09-22 11:26',
      snippet: '市场部的渠道合作合同在 OA 里走到会签第三步被驳回了，理由是附件版本不对，但我看上传的明明是 V3 终版。麻烦帮我看看流程引擎的审批记录，急用，这周必须走完。' },
    { from: '兴业银行', subject: '您的电子账单已出具', att: true, time: '09-22 09:05',
      snippet: '尊敬的客户，您的信用卡 2026 年 9 月电子账单已出具，本期应还金额 ¥8,903.16，到期还款日 10 月 8 日。点击附件查看账单明细，也可通过手机银行查询并一键还款。' },
    { from: '招商银行信用卡中心', subject: '您的 8 月电子对账单已生成', att: true, time: '09-21 08:30',
      snippet: '尊敬的客户：您名下尾号 6688 的信用卡 2026 年 8 月账单已出账，本期账单金额 ¥2,976.00，最低还款额 ¥297.60，到期还款日 09 月 12 日。本邮件为历史账单归档通知，无需回复。' },
    { from: '陈嘉时', subject: '设计稿 V3 已上传，麻烦验收', time: '09-20 19:11',
      snippet: '改了三版的控制台首页设计稿终于定稿了，源文件在 Figma 项目「中台改版」里，标注也补全了。重点看数据看板的空态和加载态，移动端适配稿周五给。确认无误我就切图交付。' },
    { from: '灵犀云市场', subject: '双 11 预售清单：数据库与 CDN 组合价', time: '09-20 15:33',
      snippet: '预售通道已开启：RDS 高可用版年付 5.5 折，CDN 流量包买 10TB 送 3TB。现在付定金可锁定价格，尾款 11 月 1 日支付即可。已有 2,341 家企业参与本次预售。' },
    { from: 'GitHub', subject: '[lingxi/mail] Weekly security alert digest', time: '09-20 08:00',
      snippet: 'Weekly digest for repository lingxi/mail: 2 dependency updates available, 1 security advisory affecting lodash@4.17.19, and 3 new CVEs matched your alert settings. View the security tab for remediation guidance.' },
    { from: '刘振宇', subject: '关于差旅报销新规的通知', time: '09-19 17:20',
      snippet: '自 10 月 1 日起差旅报销执行新规：高铁一等座需事前审批，住宿标准按城市分档（一线 600/晚，其他 450/晚），发票需在行程结束后 30 天内提交，逾期系统自动关闭单据。' },
    { from: '招商银行储蓄卡', subject: '账户余额变动提醒（收入 ¥12,500.00）', time: '09-19 10:44',
      snippet: '您的账户 6225****8876 于 09-19 10:43 入账一笔代发交易，金额人民币 12,500.00 元，付款方为灵犀科技（工资）。可用余额 ¥57,495.80。本邮件为通知类邮件，请勿直接回复。' },
    { from: '赵曼', subject: '服务器证书下周到期，需要续费确认', time: '09-18 16:08',
      snippet: 'api.lingxi-mail.com 的 TLS 证书 9 月 28 日到期，通配符证书续费需要走采购流程，大概 3 个工作日。如果这周内不提交，到期后 App 端会有拦截告警，麻烦今天确认预算。' },
    { from: '京东金融', subject: '白条账单日出账提醒', time: '09-18 09:12',
      snippet: '您 9 月的白条账单已出账：本期金额 ¥657.40，最低还款 ¥65.74，还款日 10 月 05 日。绑定银行卡自动还款可享立减优惠，活动详情见 App。' },
    { from: '孙浩', subject: '新同事入职账号申请（运营岗 ×2）', time: '09-17 14:55',
      snippet: '下周一两位运营新同事入职，需要开通：邮箱、OA、数据看板（只读）和客服工单系统的坐席权限。入职资料已同步 HR 系统，麻烦按流程开通，有问题电话找我。' },
    { from: '邮豆生活', subject: '咖啡豆年度囤货节：满 199 减 60', time: '09-17 08:21',
      snippet: '一年一度的囤货节来了！埃塞俄比亚耶加雪菲、哥伦比亚蕙兰产地直采，全店满 199 减 60，老客户额外赠挂耳滤包 20 片。活动截至 9 月 30 日。' }
  ];

  const lines = [];
  let eNo = 0;
  const ref = () => 'e' + (++eNo);

  lines.push('- generic [active] [ref=' + ref() + ']:');
  lines.push('  - banner [ref=' + ref() + ']:');
  lines.push('    - link "灵犀邮箱" [ref=' + ref() + '] [cursor=pointer]:');
  lines.push('      - /url: /mail/inbox');
  lines.push('    - searchbox "搜索邮件" [ref=' + ref() + ']');
  lines.push('    - button "写信" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - img "账号头像" [ref=' + ref() + ']');
  lines.push('    - button "设置" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - button "退出登录" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('  - navigation "文件夹" [ref=' + ref() + ']:');
  ['收件箱 (86)', '星标邮件 (5)', '已发送', '草稿箱 (2)', '废纸篓', '垃圾邮件 (12)'].forEach((t) => {
    lines.push('    - link "' + t + '" [ref=' + ref() + '] [cursor=pointer]');
  });
  lines.push('  - main [ref=' + ref() + ']:');
  lines.push('    - heading "收件箱" [level=1] [ref=' + ref() + ']');
  lines.push('    - checkbox "全选本页邮件" [ref=' + ref() + ']');
  lines.push('    - button "刷新" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - combobox "筛选" [ref=' + ref() + ']:');
  ['全部邮件', '未读', '带附件'].forEach((o) => lines.push('      - option "' + o + '" [ref=' + ref() + ']'));
  lines.push('    - searchbox "在结果中搜索" [ref=' + ref() + ']');
  lines.push('    - button "清除筛选" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - list "邮件列表（按时间倒序，共 18 封）" [ref=' + ref() + ']:');

  MAILS.forEach((m, i) => {
    lines.push('      - listitem "邮件 ' + (i + 1) + '：' + m.from + ' · ' + m.subject + '" [ref=' + ref() + ']:');
    lines.push('        - checkbox "选择这封邮件" [ref=' + ref() + ']');
    lines.push('        - img "' + (m.star ? '已标星' : '未标星') + '" [ref=' + ref() + ']');
    lines.push('        - link "' + m.from + '" [ref=' + ref() + '] [cursor=pointer]:');
    lines.push('          - /url: /mail/search?from=' + (i + 1));
    lines.push('        - link "' + m.subject + (m.att ? '（附件）' : '') + '" [ref=' + ref() + '] [cursor=pointer]:');
    lines.push('          - /url: /mail/read/' + (2400 + i * 17));
    if (m.att) lines.push('        - img "附件回形针" [ref=' + ref() + ']');
    lines.push('        - text: ' + m.snippet);
    lines.push('        - text: ' + m.time);
    lines.push('        - button "归档" [ref=' + ref() + '] [cursor=pointer]');
    lines.push('        - button "删除" [ref=' + ref() + '] [cursor=pointer]');
    lines.push('        - button "标为未读" [ref=' + ref() + '] [cursor=pointer]');
  });

  lines.push('    - navigation "分页" [ref=' + ref() + ']:');
  lines.push('      - button "上一页" [ref=' + ref() + '] [disabled]');
  lines.push('      - text: 第 1 / 5 页 · 共 86 封，未读 23 封');
  lines.push('      - button "下一页" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('  - contentinfo [ref=' + ref() + ']:');
  lines.push('    - text: © 2026 灵犀邮箱 · 企业版');

  return lines.join('\n');
}

/* ===================== 招聘简历快照生成器 =====================
 * 候选人管理页：顶栏 + 筛选区 + 16 位候选人（每位 4 个 ref），ref 总数约 95。
 * 强混淆点：两个同名「李强」（一个超预算、一个技能不符）、多位候选人只差
 * 一个关键条件（缺 TypeScript / 期望薪资超 35K / 岗位不是高级）。
 * 唯一目标：周一鸣 —— 高级前端工程师 + React 与 TypeScript 皆有 + 期望薪资 ≤ 35K。
 */
function buildResumeSnapshot() {
  const ROWS = [
    { name: '李强', job: '高级前端工程师', skills: 'React、TypeScript、Webpack、Jest', last: '远山电商 高级前端（2019.06 至今）', pay: '38K', years: '7', date: '09-22' },
    { name: '李强', job: '前端工程师', skills: 'Vue、JavaScript、Vite、ECharts', last: '蓝湾信息 前端（2022.03 至今）', pay: '28K', years: '4', date: '09-21' },
    { name: '张雨薇', job: '高级前端工程师', skills: 'React、TypeScript、Node.js、微前端', last: '启明星云 高级前端（2018.07 至今）', pay: '45K', years: '8', date: '09-22' },
    { name: '刘畅', job: '前端工程师', skills: 'React、TypeScript、React Query', last: '橘子互娱 前端（2023.04 至今）', pay: '30K', years: '3', date: '09-20' },
    { name: '陈默', job: '高级前端工程师', skills: 'React、Redux、Webpack、Node.js', last: '北岭科技 高级前端（2020.01 至今）', pay: '33K', years: '6', date: '09-22' },
    { name: '周一鸣', job: '高级前端工程师', skills: 'React、TypeScript、Node.js、Vite、CI/CD', last: '星图数据 高级前端（2020.09 至今）', pay: '32K', years: '6', date: '09-23' },
    { name: '吴佳宁', job: '测试工程师', skills: 'Selenium、Postman、JMeter、禅道', last: '白云山健康 测试（2021.05 至今）', pay: '25K', years: '5', date: '09-19' },
    { name: '郑飞', job: '高级前端工程师', skills: 'React、TypeScript、qiankun 微前端、前端监控', last: '大河金服 资深前端（2017.03 至今）', pay: '36K', years: '9', date: '09-21' },
    { name: '王思颖', job: '前端工程师', skills: 'React、JavaScript、微信小程序', last: '拾光文创 前端（2024.02 至今）', pay: '26K', years: '2', date: '09-20' },
    { name: '冯超', job: 'Java 后端工程师', skills: 'Java、Spring Cloud、MySQL、Redis', last: '万川物流 后端（2019.11 至今）', pay: '30K', years: '6', date: '09-18' },
    { name: '徐蕾', job: '高级前端工程师', skills: 'React、TypeScript、AntV 数据可视化', last: '晨曦医疗 高级前端（2021.02 至今）', pay: '36K', years: '5', date: '09-22' },
    { name: '高翔', job: '测试开发工程师', skills: 'Python、Pytest、Allure、Jenkins', last: '远航出行 测试开发（2022.08 至今）', pay: '28K', years: '4', date: '09-17' },
    { name: '罗静', job: '前端工程师', skills: 'React、TypeScript、微信小程序', last: '竹间教育 前端（2023.06 至今）', pay: '27K', years: '3', date: '09-19' },
    { name: '黄志远', job: '高级前端工程师', skills: 'Vue、TypeScript、Vite、Pinia', last: '南山智驾 高级前端（2019.04 至今）', pay: '33K', years: '6', date: '09-21' },
    { name: '宋雨桐', job: 'UI 设计师', skills: 'Figma、Sketch、C4D', last: '光合工作室 UI 设计（2023.01 至今）', pay: '20K', years: '3', date: '09-16' },
    { name: '马奔腾', job: '高级前端工程师', skills: 'React、TypeScript、GraphQL、性能优化', last: '九天智算 资深前端（2016.05 至今）', pay: '40K', years: '10', date: '09-22' }
  ];

  const lines = [];
  let eNo = 0;
  const ref = () => 'e' + (++eNo);

  lines.push('- generic [active] [ref=' + ref() + ']:');
  lines.push('  - banner [ref=' + ref() + ']:');
  lines.push('    - link "星河招聘中台" [ref=' + ref() + '] [cursor=pointer]:');
  lines.push('      - /url: /hr/home');
  ['职位管理', '候选人', '面试安排', '数据看板'].forEach((t) => {
    lines.push('    - link "' + t + '" [ref=' + ref() + '] [cursor=pointer]');
  });
  lines.push('    - img "HR 头像" [ref=' + ref() + ']');
  lines.push('    - button "退出登录" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('  - main [ref=' + ref() + ']:');
  lines.push('    - heading "候选人管理" [level=1] [ref=' + ref() + ']');
  lines.push('    - searchbox "搜索姓名 / 手机号" [ref=' + ref() + ']');
  lines.push('    - combobox "投递岗位" [ref=' + ref() + ']:');
  ['全部岗位', '高级前端工程师', '前端工程师', '测试工程师', 'Java 后端工程师', 'UI 设计师'].forEach((o) => {
    lines.push('      - option "' + o + '" [ref=' + ref() + ']');
  });
  lines.push('    - combobox "处理状态" [ref=' + ref() + ']:');
  ['全部', '待处理', '已邀请面试', '已标记不合适'].forEach((o) => {
    lines.push('      - option "' + o + '" [ref=' + ref() + ']');
  });
  lines.push('    - button "查询" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - button "重置" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('    - table "候选人列表（默认展示最近 16 位）" [ref=' + ref() + ']:');

  ROWS.forEach((r, i) => {
    lines.push('      - row "候选人 ' + r.name + '（' + r.job + '）":');
    lines.push('        - cell "' + r.name + '":');
    lines.push('          - link "' + r.name + '" [ref=' + ref() + '] [cursor=pointer]:');
    lines.push('            - /url: /hr/candidates/' + (3100 + i * 11));
    lines.push('        - cell "投递岗位：' + r.job + '"');
    lines.push('        - cell "技能：' + r.skills + '；最近一份工作：' + r.last + '"');
    lines.push('        - cell "期望薪资：' + r.pay + ' · 工作年限：' + r.years + ' 年 · 更新时间：2026-' + r.date + '"');
    lines.push('        - button "查看简历" [ref=' + ref() + '] [cursor=pointer]');
    lines.push('        - button "邀请面试" [ref=' + ref() + '] [cursor=pointer]');
    lines.push('        - button "标记不合适" [ref=' + ref() + '] [cursor=pointer]');
  });

  lines.push('    - navigation "分页" [ref=' + ref() + ']:');
  lines.push('      - button "上一页" [ref=' + ref() + '] [disabled]');
  lines.push('      - text: 第 1 / 2 页 · 共 27 位候选人');
  lines.push('      - button "下一页" [ref=' + ref() + '] [cursor=pointer]');
  lines.push('  - contentinfo [ref=' + ref() + ']:');
  lines.push('    - text: © 2026 星河招聘中台 · 简历信息仅限招聘用途');

  return lines.join('\n');
}

/* ===================== 预设 =====================
 * group：界面上的顶层 Tab 分组。数组顺序即展示顺序。
 */
const PRESETS = [
  {
    name: '浏览器·邮箱收件箱',
    group: '浏览器操作',
    desc: '同一发件人三封相似邮件 + 每行同名「归档」按钮，答案必须落到具体 ref。',
    state: JSON.stringify({
      '任务目标': '在收件箱里找到「招商银行信用卡中心」发来的最新一期（9 月）电子对账单邮件，点击该行的「归档」按钮把它移出收件箱',
      '当前地址': 'https://mail.lingxi.example.com/inbox',
      '页面标题': '灵犀邮箱 · 收件箱',
      '已执行步骤': '已登录并进入收件箱列表页；列表按时间倒序展示 18 封邮件，未使用任何筛选',
      '可访问性快照': buildMailboxSnapshot()
    }, null, 2),
    questions: [
      { type: 'choice', name: '下一步动作', instructions: '根据快照，agent 下一步应该调用哪个 playwright-cli 工具', criteria: PLAYWRIGHT_TOOLS },
      { type: 'choice', name: '参数', instructions: '下一步动作应该作用于快照中的哪个 ref 元素（从当前 state 的快照自动解析）', criteriaFrom: 'refs' },
      { type: 'noul', name: '是否已完成', instructions: '「把招商银行信用卡中心 9 月电子对账单邮件归档」这一目标当前是否已经完成？', criteria: { true: '目标已完成', false: '目标尚未完成' } }
    ]
  },
  {
    name: '浏览器·简历筛选',
    group: '浏览器操作',
    desc: '同名候选人 + 相似技能栈 + 预算红线，多重条件下仅一位符合。',
    state: JSON.stringify({
      '任务目标': '在候选人列表中找出投递「高级前端工程师」岗位、技能同时包含 React 和 TypeScript、且期望薪资不超过 35K 的唯一候选人，点击其卡片上的「邀请面试」按钮',
      '当前地址': 'https://hr.xinghe.example.com/candidates',
      '页面标题': '星河招聘中台 · 候选人管理',
      '已执行步骤': '已进入候选人管理页；列表默认展示最近 16 位候选人，岗位与状态筛选保持「全部」未改动',
      '可访问性快照': buildResumeSnapshot()
    }, null, 2),
    questions: [
      { type: 'choice', name: '下一步动作', instructions: '根据快照，agent 下一步应该调用哪个 playwright-cli 工具', criteria: PLAYWRIGHT_TOOLS },
      { type: 'choice', name: '参数', instructions: '下一步动作应该作用于快照中的哪个 ref 元素（从当前 state 的快照自动解析）', criteriaFrom: 'refs' },
      { type: 'noul', name: '是否已完成', instructions: '「给符合条件的候选人（高级前端 + React 与 TypeScript + 期望薪资不超过 35K）发出面试邀请」这一目标当前是否已经完成？', criteria: { true: '目标已完成', false: '目标尚未完成' } }
    ]
  },
  {
    name: '浏览器·订单后台 15K',
    group: '浏览器操作',
    desc: '约 15K token / 132 个 ref 的大快照，验证大 state 下的定位稳定性。',
    state: JSON.stringify({
      '任务目标': '在订单列表中找到商品为 AirPods Pro（苹果降噪耳机）且状态是「已付款待发货」的那一笔订单，点击该行的「发货」按钮，把它标记为发货',
      '当前地址': 'https://admin.bookstore.example.com/orders',
      '页面标题': '云上书城订单中台',
      '已执行步骤': '已从「订单中心」菜单进入订单管理页；列表按下单时间倒序展示最近 15 笔订单；状态筛选保持「全部状态」未改动',
      '可访问性快照': buildMallSnapshot()
    }, null, 2),
    questions: [
      { type: 'choice', name: '下一步动作', instructions: '根据快照，agent 下一步应该调用哪个 playwright-cli 工具', criteria: PLAYWRIGHT_TOOLS },
      { type: 'choice', name: '参数', instructions: '下一步动作应该作用于快照中的哪个 ref 元素（从当前 state 的快照自动解析）', criteriaFrom: 'refs' },
      { type: 'noul', name: '是否已完成', instructions: '「把 AirPods Pro 待发货订单标记为发货」这一目标当前是否已经完成？', criteria: { true: '目标已完成', false: '目标尚未完成' } }
    ]
  },
  {
    name: '工单分派',
    group: '意图识别',
    desc: '一条客服消息同时做分类、愤怒打分与紧急门禁 —— 三种题型混用的最小示例。',
    state: '你好，我已经尝试连接 Stripe 账户三天了，集成一直失败。我正在损失订单。请尽快帮忙处理。',
    questions: [
      { type: 'choice', name: '部门', instructions: '这个问题应该由哪个团队处理', criteria: { '账务': '支付、发票、退款相关的问题', '技术': '集成报错、接口失败、程序缺陷', '销售': '价格咨询、套餐升级、新购买' } },
      { type: 'score', name: '愤怒程度', instructions: '客户有多愤怒', criteria: ['平静或礼貌，没有抱怨', '有些不满，提到问题但保持克制', '愤怒，威胁要离开或使用敌意语言'] },
      { type: 'noul', name: '是否紧急', instructions: '这条消息是否表达了紧迫性？', criteria: { true: '表达了紧迫性，需要优先处理', false: '没有紧迫性' } }
    ]
  },
  {
    name: '内容审核',
    group: '意图识别',
    desc: '判断一段文字是否含攻击性语言、情感打分与主题分类。',
    state: '我们团队终于上线了新版本的数据看板。图表加载时间降到一秒以内，用户抱怨了好几周的导出故障也修好了。说实话这是一次很棒的发布。',
    questions: [
      { type: 'noul', name: '是否含违规内容', instructions: '这段文字是否包含辱骂、敌意或攻击性语言？', criteria: { true: '包含辱骂或攻击性语言', false: '不包含攻击性语言' } },
      { type: 'score', name: '情感倾向', instructions: '这段文字的情感有多负面', criteria: ['非常负面', '偏负面', '中性', '偏正面', '非常正面'] },
      { type: 'choice', name: '主题分类', instructions: '这段文字的主要话题是什么', criteria: { '产品更新': '关于产品发布或新功能的消息', '用户投诉': '用户的抱怨或故障反馈', '营销推广': '营销或广告内容' } }
    ]
  },
  {
    name: '意图路由',
    group: '意图识别',
    desc: '识别用户意图，并判断是否属于需要二次确认的高风险资金操作。',
    state: '我现在想从储蓄账户转 2000 元到活期账户。',
    questions: [
      { type: 'choice', name: '用户意图', instructions: '用户想要做什么', criteria: { '查询余额': '查看账户余额', '发起转账': '确认或发起一笔资金转账', '其他求助': '咨询其他问题' } },
      { type: 'noul', name: '是否高风险', instructions: '这是否属于需要用户二次确认的高风险资金操作？', criteria: { true: '高风险，需要二次确认', false: '低风险，可以直接执行' } }
    ]
  },
  {
    name: '上下文裁剪',
    group: 'Agent 上下文裁剪',
    desc: 'fast-jev-compaction：判断哪些工具调用/结果值得继续保留在上下文里。',
    state: JSON.stringify({
      '任务目标': '修复订单导出接口超时问题',
      '工具调用': { '编号': 'call_7f3a', '工具': 'bash', '输入': 'npm test -- orders/export.spec.ts' },
      '结果摘要': '报错，830 字符（已省略）',
      '近期对话': '助手：已定位到 N+1 查询问题，准备改写 repository'
    }, null, 2),
    questions: [
      { type: 'noul', name: '是否保留调用', instructions: '这个工具调用本身对继续完成任务还重要吗？', criteria: { true: '仍然值得保留这个调用', false: '这个调用已经不相关了' } },
      { type: 'noul', name: '是否保留完整结果', instructions: '这个工具结果的全文还需要原样保留吗？', criteria: { true: '需要保留完整结果', false: '一句简短摘要就够了' } }
    ]
  }
];
