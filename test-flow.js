// test-flow.js - 完整业务流程测试
const BASE = 'http://localhost:3000/api';

async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const res = await fetch(BASE + path, { ...options, headers });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function main() {
  console.log('====================================');
  console.log('  塔罗牌分销系统 - 完整流程测试');
  console.log('====================================\n');

  // 1. 客户验证邀请码（二级代理的邀请码）
  console.log('【1】客户验证邀请码 (二级代理 TAROT8B2)');
  let r = await req('/shop/verify', { method: 'POST', body: JSON.stringify({ invite_code: 'TAROT8B2' }) });
  console.log('  结果:', r.ok ? '✅ 验证成功' : '❌ ' + r.data.error);
  const customerToken = r.data.token;
  console.log('  对应代理:', r.data.agentName);

  // 2. 客户获取商品列表
  console.log('\n【2】客户获取商品列表');
  r = await req('/shop/products', { headers: { Authorization: 'Bearer ' + customerToken } });
  console.log('  结果:', r.ok ? `✅ 获取到 ${r.data.length} 个商品` : '❌ ' + r.data.error);
  const productId = r.data[0].id;
  console.log('  第一个商品:', r.data[0].name, '¥' + r.data[0].price);

  // 3. 客户下单
  console.log('\n【3】客户下单');
  r = await req('/shop/orders', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + customerToken },
    body: JSON.stringify({
      product_id: productId,
      quantity: 1,
      customer_name: '测试客户',
      customer_phone: '13900000000',
      customer_address: '北京市朝阳区测试路1号'
    })
  });
  console.log('  结果:', r.ok ? '✅ 下单成功' : '❌ ' + r.data.error);
  console.log('  订单号:', r.data.order_no);
  console.log('  消息:', r.data.message);

  // 4. 二级代理登录
  console.log('\n【4】二级代理登录 (agent2)');
  r = await req('/auth/agent/login', { method: 'POST', body: JSON.stringify({ username: 'agent2', password: '123456' }) });
  console.log('  结果:', r.ok ? '✅ 登录成功' : '❌ ' + r.data.error);
  const agent2Token = r.data.token;
  console.log('  代理:', r.data.user.name, '佣金比例:', (r.data.user.commission_rate * 100) + '%');

  // 5. 二级代理查看通知
  console.log('\n【5】二级代理查看通知');
  r = await req('/agent/notifications', { headers: { Authorization: 'Bearer ' + agent2Token } });
  console.log('  结果:', r.ok ? `✅ ${r.data.list.length} 条通知，${r.data.unread_count} 条未读` : '❌ ' + r.data.error);
  if (r.data.list.length > 0) console.log('  最新通知:', r.data.list[0].title);

  // 6. 二级代理查看佣金
  console.log('\n【6】二级代理查看佣金统计');
  r = await req('/agent/commissions/summary', { headers: { Authorization: 'Bearer ' + agent2Token } });
  console.log('  结果:', r.ok ? '✅ 获取成功' : '❌ ' + r.data.error);
  if (r.ok) {
    console.log('  直接佣金: ¥' + r.data.direct_total.toFixed(2));
    console.log('  佣金总额: ¥' + r.data.grand_total.toFixed(2));
  }

  // 7. 二级代理查看订单（验证看不到商品价格）
  console.log('\n【7】二级代理查看订单（验证看不到商品价格）');
  r = await req('/agent/orders', { headers: { Authorization: 'Bearer ' + agent2Token } });
  console.log('  结果:', r.ok ? `✅ ${r.data.length} 个订单` : '❌ ' + r.data.error);
  if (r.ok && r.data.length > 0) {
    const o = r.data[0];
    console.log('  订单:', o.order_no);
    console.log('  商品:', o.product_name);
    console.log('  客户:', o.customer_name);
    console.log('  佣金: ¥' + o.my_commission.toFixed(2));
    console.log('  ⚠️ 验证: 是否有商品价格字段?', o.product_price ? '❌ 泄露了价格!' : '✅ 未泄露价格');
  }

  // 8. 一级代理登录
  console.log('\n【8】一级代理登录 (agent1)');
  r = await req('/auth/agent/login', { method: 'POST', body: JSON.stringify({ username: 'agent1', password: '123456' }) });
  console.log('  结果:', r.ok ? '✅ 登录成功' : '❌ ' + r.data.error);
  const agent1Token = r.data.token;

  // 9. 一级代理查看通知（应该收到下级订单通知）
  console.log('\n【9】一级代理查看通知（下级订单通知）');
  r = await req('/agent/notifications', { headers: { Authorization: 'Bearer ' + agent1Token } });
  console.log('  结果:', r.ok ? `✅ ${r.data.list.length} 条通知，${r.data.unread_count} 条未读` : '❌ ' + r.data.error);
  if (r.data.list.length > 0) console.log('  最新通知:', r.data.list[0].title);

  // 10. 一级代理查看佣金（应该有间接佣金）
  console.log('\n【10】一级代理查看佣金统计');
  r = await req('/agent/commissions/summary', { headers: { Authorization: 'Bearer ' + agent1Token } });
  if (r.ok) {
    console.log('  直接佣金: ¥' + r.data.direct_total.toFixed(2));
    console.log('  间接佣金: ¥' + r.data.indirect_total.toFixed(2));
    console.log('  佣金总额: ¥' + r.data.grand_total.toFixed(2));
  }

  // 11. 管理员登录并查看订单
  console.log('\n【11】管理员查看订单');
  r = await req('/auth/admin/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const adminToken = r.data.token;
  r = await req('/admin/orders', { headers: { Authorization: 'Bearer ' + adminToken } });
  console.log('  结果:', r.ok ? `✅ ${r.data.length} 个订单` : '❌ ' + r.data.error);
  let orderId;
  if (r.ok && r.data.length > 0) {
    const o = r.data[0];
    orderId = o.id;
    console.log('  订单:', o.order_no);
    console.log('  商品:', o.product_name, '总价: ¥' + o.total_price);
    console.log('  客户:', o.customer_name, o.customer_phone);
    console.log('  代理:', o.agent_name, '(' + (o.agent_role === 'agent1' ? '一级' : '二级') + ')');
    console.log('  状态:', o.status);
  }

  // 12. 管理员发货
  console.log('\n【12】管理员发货（录入快递单号）');
  r = await req(`/admin/orders/${orderId}/ship`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ tracking_no: 'SF1234567890', tracking_company: '顺丰速运' })
  });
  console.log('  结果:', r.ok ? '✅ 发货成功' : '❌ ' + r.data.error);
  console.log('  消息:', r.data.message);

  // 13. 二级代理查看发货通知
  console.log('\n【13】二级代理查看发货通知');
  r = await req('/agent/notifications', { headers: { Authorization: 'Bearer ' + agent2Token } });
  if (r.data.list.length > 0) {
    console.log('  最新通知:', r.data.list[0].title);
    console.log('  通知内容:', r.data.list[0].content);
  }

  // 14. 一级代理查看发货通知
  console.log('\n【14】一级代理查看发货通知');
  r = await req('/agent/notifications', { headers: { Authorization: 'Bearer ' + agent1Token } });
  if (r.data.list.length > 0) {
    console.log('  最新通知:', r.data.list[0].title);
    console.log('  通知内容:', r.data.list[0].content);
  }

  // 15. 测试佣金抽成30%限制
  console.log('\n【15】测试佣金抽成30%限制');
  // 一级代理佣金20%，二级代理当前佣金15.38%（20/1.3）
  // 尝试设置更低佣金
  const minRate = (0.20 / 1.3);
  r = await req('/agent/sub-agents/3/commission', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + agent1Token },
    body: JSON.stringify({ rate: 0.10 })  // 10% < minRate 15.38%
  });
  console.log('  尝试设置二级佣金为10%（低于下限15.4%）:');
  console.log('  结果:', r.ok ? '❌ 应该被拒绝!' : '✅ 正确拒绝 - ' + r.data.error);

  r = await req('/agent/sub-agents/3/commission', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + agent1Token },
    body: JSON.stringify({ rate: 0.16 })  // 16% > minRate 15.38%，抽成 = (20-16)/16 = 25% < 30%
  });
  console.log('  尝试设置二级佣金为16%（抽成25%，合规）:');
  console.log('  结果:', r.ok ? '✅ 设置成功' : '❌ ' + r.data.error);

  console.log('\n====================================');
  console.log('  ✅ 全部流程测试完成！');
  console.log('====================================');
}

main().catch(console.error);
