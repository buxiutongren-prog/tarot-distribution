// test-chain.js - 测试邀请链：管理员→一级代理→二级代理→客户下单→佣金链
const http = require('http');

const API = 'http://localhost:3000/api';

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API + path);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname, method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  let passed = 0, failed = 0;
  
  function check(name, condition, detail = '') {
    if (condition) { console.log(`  ✅ ${name} ${detail}`); passed++; }
    else { console.log(`  ❌ ${name} ${detail}`); failed++; }
  }

  // ===== 1. 管理员登录 =====
  console.log('\n📋 1. 管理员登录');
  const admin = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin123' });
  check('管理员登录', !!admin.token, `invite_code=${admin.user.invite_code}`);
  check('管理员有 invite_code', !!admin.user.invite_code);
  check('管理员有 commission_rate', admin.user.commission_rate === 0.25, `rate=${(admin.user.commission_rate*100).toFixed(1)}%`);
  const adminToken = admin.token;
  
  // ===== 2. 管理员看到自己的直邀代理（agent1） =====
  console.log('\n📋 2. 管理员直邀代理');
  const agents = await req('GET', '/admin/agents', adminToken);
  const myAgents = agents.filter(a => a.parent_id === admin.user.id);
  console.log(`  管理员直邀代理: ${myAgents.length}人`);
  myAgents.forEach(a => console.log(`    ${a.name} | ${a.role} | invite:${a.invite_code} | parent_id:${a.parent_id}`));
  check('张一级是管理员的直邀代理', myAgents.some(a => a.name === '张一级'), `parent_id=${admin.user.id}`);
  
  // ===== 3. 一级代理登录 =====
  console.log('\n📋 3. 一级代理登录');
  const agent1 = await req('POST', '/auth/login', null, { username: 'agent1', password: '123456' });
  check('一级代理登录', !!agent1.token, `invite_code=${agent1.user.invite_code}`);
  check('一级代理有 invite_code', !!agent1.user.invite_code, `code=${agent1.user.invite_code}`);
  const agent1Token = agent1.token;
  
  // ===== 4. 一级代理看到自己的邀请码 =====
  console.log('\n📋 4. 一级代理邀请码');
  const agent1Profile = await req('GET', '/agent/profile', agent1Token);
  check('一级代理只看到自己的邀请码', agent1Profile.invite_code === agent1.user.invite_code);
  check('一级代理有商城链接', agent1Profile.invite_link.includes('shop.html'));
  check('一级代理有注册链接', agent1Profile.register_link.includes('register'));
  
  // ===== 5. 二级代理通过一级代理邀请码注册 =====
  console.log('\n📋 5. 二级代理注册（通过agent1邀请码）');
  const regResult = await req('POST', '/auth/agent/register', null, {
    invite_code: agent1.user.invite_code,
    username: 'testagent2', password: '123456',
    name: '测试二级', phone: '13900000002'
  });
  check('二级代理注册成功', !!regResult.success, `role=${regResult.role}`);
  
  // 二级代理登录
  const agent2 = await req('POST', '/auth/login', null, { username: 'testagent2', password: '123456' });
  check('二级代理登录', !!agent2.token, `invite_code=${agent2.user.invite_code}`);
  const agent2Token = agent2.token;
  
  // ===== 6. 二级代理看到自己的邀请码 =====
  console.log('\n📋 6. 二级代理邀请码');
  const agent2Profile = await req('GET', '/agent/profile', agent2Token);
  check('二级代理只看到自己的邀请码', agent2Profile.invite_code === agent2.user.invite_code);
  check('二级代理上级是张一级', agent2Profile.parent && agent2Profile.parent.name === '张一级');
  check('二级代理有商城链接', agent2Profile.invite_link.includes('shop.html'));
  check('二级代理有注册链接', agent2Profile.register_link.includes('register'));
  
  // ===== 7. 一级代理查看下级 =====
  console.log('\n📋 7. 一级代理查看下级');
  const subs = await req('GET', '/agent/sub-agents', agent1Token);
  check('一级代理看到下级', subs.length >= 1, `下级数:${subs.length}`);
  check('包含测试二级', subs.some(s => s.name === '测试二级'));
  // 确认"李二级"也在（种子数据自动创建）
  const liAgent = subs.find(s => s.name === '李二级');
  if (liAgent) console.log('    李二级（种子数据）也在下级列表中 ✓');
  
  // ===== 8. 客户通过二级代理邀请码下单 =====
  console.log('\n📋 8. 客户通过二级代理邀请码下单');
  const verify = await req('POST', '/shop/verify', null, { invite_code: agent2.user.invite_code });
  check('客户验证通过', !!verify.token);
  const customerToken = verify.token;
  
  // 获取商品
  const products = await req('GET', '/shop/products', customerToken);
  check('获取商品列表', products.length > 0, `${products.length}个商品`);
  
  const order = await req('POST', '/shop/orders', customerToken, {
    product_id: products[0].id, quantity: 1,
    customer_name: '测试客户', customer_phone: '18800000001',
    customer_address: '测试地址', remark: '测试下单'
  });
  check('下单成功', !!order.success, `订单号:${order.order_no}`);
  
  // ===== 9. 验证佣金链 =====
  console.log('\n📋 9. 验证佣金链');
  const adminOrders = await req('GET', '/admin/orders', adminToken);
  const testOrder = adminOrders.find(o => o.order_no === order.order_no);
  check('管理员看到订单', !!testOrder);
  
  // 检查佣金
  const agent1Commissions = await req('GET', '/agent/commissions', agent1Token);
  check('一级代理收到间接佣金', agent1Commissions.some(c => c.level === 'indirect'),
    `间接佣金:¥${agent1Commissions.filter(c=>c.level==='indirect').reduce((s,c)=>s+c.amount,0)}`);
  
  const agent2Commissions = await req('GET', '/agent/commissions', agent2Token);
  check('二级代理收到直接佣金', agent2Commissions.some(c => c.level === 'direct'),
    `直接佣金:¥${agent2Commissions.filter(c=>c.level==='direct').reduce((s,c)=>s+c.amount,0)}`);
  
  // ===== 10. 管理员自己的邀请码页面 =====
  console.log('\n📋 10. 管理员邀请码');
  const adminProfile = await req('GET', '/auth/me', adminToken);
  check('管理员有 invite_code', !!adminProfile.invite_code, `code=${adminProfile.invite_code}`);
  check('管理员有 commission_rate', adminProfile.commission_rate === 0.25);
  
  // ===== 11. 验证价格隔离 =====
  console.log('\n📋 11. 价格隔离');
  const agent1Orders = await req('GET', '/agent/orders', agent1Token);
  const agentOrder = agent1Orders.find(o => o.order_no === order.order_no);
  check('代理看不到商品价格', agentOrder && agentOrder.product_price === undefined, 'price字段已隐藏');
  
  // ===== 12. 另一条链：一级代理直接客户下单 =====
  console.log('\n📋 12. 一级代理直接客户下单');
  const verify2 = await req('POST', '/shop/verify', null, { invite_code: agent1.user.invite_code });
  const customerToken2 = verify2.token;
  const order2 = await req('POST', '/shop/orders', customerToken2, {
    product_id: products[1].id, quantity: 1,
    customer_name: '直接客户', customer_phone: '18800000002',
    customer_address: '地址二', remark: ''
  });
  check('一级代理直接客户下单成功', !!order2.success);
  
  const agent1Comms2 = await req('GET', '/agent/commissions', agent1Token);
  const directFromAgent1 = agent1Comms2.filter(c => c.level === 'direct');
  check('一级代理有直接佣金', directFromAgent1.length >= 1, `直接佣金数:${directFromAgent1.length}`);
  
  // ===== 13. 验证：小红不走小明的邀请码，小红出单和小明无关 =====
  console.log('\n📋 13. 验证邀请链隔离');
  // 新建另一个一级代理（不用agent1的邀请码，用管理员的）
  const reg2 = await req('POST', '/auth/agent/register', null, {
    invite_code: admin.user.invite_code,
    username: 'otheragent1', password: '123456',
    name: '另一个一级', phone: '13911110001'
  });
  check('另一个一级注册成功', !!reg2.success, `role=${reg2.role}`);
  
  const otherAgentToken = (await req('POST', '/auth/login', null, { username: 'otheragent1', password: '123456' })).token;
  
  // "小红"（otheragent1）下单
  const verify3 = await req('POST', '/shop/verify', null, { invite_code: (await req('GET', '/agent/profile', otherAgentToken)).invite_code });
  const order3 = await req('POST', '/shop/orders', verify3.token, {
    product_id: products[2].id, quantity: 1,
    customer_name: '小红客户', customer_phone: '18800000003',
    customer_address: '地址三', remark: ''
  });
  check('小红(另一个一级)下单成功', !!order3.success);
  
  // agent1("小明")不应该看到小红的下单
  const agent1OrdersAfter = await req('GET', '/agent/orders', agent1Token);
  const hasHongOrder = agent1OrdersAfter.some(o => o.order_no === order3.order_no);
  check('小明看不到小红的订单', !hasHongOrder, '邀请链隔离正确');
  
  // 管理员应该看到小红的订单（小红是管理员的直邀代理）
  const allAdminOrders = await req('GET', '/admin/orders', adminToken);
  const adminSeesHong = allAdminOrders.some(o => o.order_no === order3.order_no);
  check('管理员能看到小红的订单', adminSeesHong);
  
  // ===== 汇总 =====
  console.log(`\n========================================`);
  console.log(`  结果: ${passed} 通过 / ${failed} 失败`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
