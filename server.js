// server.js - 塔罗牌分销系统主服务（PostgreSQL 版）
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { get, all, run, pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'tarot-distribution-secret-2024';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 辅助：解析商品图片（兼容旧格式字符串和新格式JSON数组）
function parseProductImages(product) {
  if (!product || !product.image) return [];
  if (typeof product.image === 'string' && product.image.startsWith('[')) {
    try { return JSON.parse(product.image); } catch(e) { return []; }
  }
  return product.image ? [product.image] : [];
}
function formatProduct(p) {
  if (!p) return p;
  return { ...p, images: parseProductImages(p) };
}

// ============ 工具函数 ============
function genToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}
function genOrderNo() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `T${ts}${rand}`;
}
function genInviteCode() {
  return 'TAROT' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// 认证中间件
function auth(requiredRole) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '请先登录' });
    try {
      req.user = jwt.verify(token, SECRET);
      if (requiredRole) {
        const rolePriority = { admin: 3, agent1: 2, agent2: 1 };
        if (rolePriority[req.user.role] < rolePriority[requiredRole]) {
          return res.status(403).json({ error: '权限不足' });
        }
      }
      next();
    } catch (e) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
  };
}

// 客户邀请码验证中间件
function customerAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先输入邀请码' });
  try {
    req.customer = jwt.verify(token, SECRET);
    if (req.customer.type !== 'customer') return res.status(403).json({ error: '无效的客户凭证' });
    next();
  } catch (e) {
    return res.status(401).json({ error: '邀请码已过期，请重新输入' });
  }
}

// 发送通知（异步）
async function notify(userId, type, title, content, orderId) {
  await run('INSERT INTO notifications (user_id, type, title, content, order_id) VALUES (?, ?, ?, ?, ?)',
    [userId, type, title, content, orderId || null]);
}

// 获取代理的上级链（异步）
async function getAgentChain(agentId) {
  const chain = [];
  let current = agentId;
  while (current) {
    const user = await get('SELECT id, name, role, parent_id, commission_rate FROM users WHERE id = ?', [current]);
    if (!user) break;
    chain.push(user);
    current = user.parent_id;
  }
  return chain;
}

// ============ 认证路由 ============

// 管理员登录
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await get('SELECT * FROM users WHERE username = ? AND role = ?', [username, 'admin']);
    if (!user) return res.status(401).json({ error: '管理员账号不存在' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '密码错误' });
    if (user.status !== 'active') return res.status(403).json({ error: user.status === 'deleted' ? '账号已注销' : '账号已禁用' });
    const token = genToken({ id: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理登录
app.post('/api/auth/agent/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await get("SELECT * FROM users WHERE username = ? AND role IN ('agent1','agent2')", [username]);
    if (!user) return res.status(401).json({ error: '代理账号不存在' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '密码错误' });
    if (user.status !== 'active') return res.status(403).json({ error: user.status === 'deleted' ? '账号已注销' : '账号已禁用' });
    const token = genToken({ id: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, commission_rate: user.commission_rate, invite_code: user.invite_code } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理通过邀请码注册
app.post('/api/auth/agent/register', async (req, res) => {
  try {
    const { invite_code, username, password, name, phone } = req.body;
    if (!invite_code || !username || !password || !name) {
      return res.status(400).json({ error: '请填写完整信息' });
    }
    const parent = await get("SELECT * FROM users WHERE invite_code = ? AND role IN ('admin','agent1') AND status NOT IN ('disabled','deleted')", [invite_code]);
    if (!parent) return res.status(400).json({ error: '邀请码无效或已失效' });
    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ error: '用户名已存在' });

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);
    const newInviteCode = genInviteCode();
    const role = parent.role === 'admin' ? 'agent1' : 'agent2';
    const defaultRate = +(parent.commission_rate / 1.3).toFixed(4);

    const result = await run('INSERT INTO users (username, password, name, phone, role, parent_id, commission_rate, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [username, hashedPassword, name, phone || null, role, parent.id, defaultRate, newInviteCode]);
    res.json({ success: true, message: '注册成功，请登录', agentId: result.lastInsertRowid, role: role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 统一登录（管理员 + 代理）
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: '账号不存在' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '密码错误' });
    if (user.status !== 'active') return res.status(403).json({ error: user.status === 'deleted' ? '账号已注销' : '账号已禁用' });
    const token = genToken({ id: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, commission_rate: user.commission_rate, invite_code: user.invite_code } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 获取当前用户信息
app.get('/api/auth/me', auth('agent2'), async (req, res) => {
  try {
    const user = await get('SELECT id, username, name, phone, role, parent_id, commission_rate, invite_code, status, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    let parent = null;
    if (user.parent_id) {
      parent = await get('SELECT id, name, commission_rate FROM users WHERE id = ?', [user.parent_id]);
    }
    res.json({ ...user, parent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 客户商城路由 ============

// 客户验证邀请码
app.post('/api/shop/verify', async (req, res) => {
  try {
    const { invite_code } = req.body;
    if (!invite_code) return res.status(400).json({ error: '请输入邀请码' });
    const agent = await get("SELECT id, name, invite_code FROM users WHERE invite_code = ? AND role IN ('agent1','agent2') AND status NOT IN ('disabled','deleted')", [invite_code.toUpperCase()]);
    if (!agent) return res.status(400).json({ error: '邀请码无效，请检查后重试' });
    const token = genToken({ type: 'customer', agentId: agent.id, invite_code: agent.invite_code });
    res.json({ token, agentName: agent.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 客户获取商品列表
app.get('/api/shop/products', customerAuth, async (req, res) => {
  try {
    const products = await all("SELECT id, name, description, price, image, stock FROM products WHERE status = 'active' ORDER BY id", []);
    res.json(products.map(formatProduct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 客户获取商品详情
app.get('/api/shop/products/:id', customerAuth, async (req, res) => {
  try {
    const product = await get("SELECT id, name, description, price, image, stock, detail FROM products WHERE id = ? AND status = 'active'", [req.params.id]);
    if (!product) return res.status(404).json({ error: '商品不存在' });
    res.json(formatProduct(product));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 客户下单
app.post('/api/shop/orders', customerAuth, async (req, res) => {
  try {
    const { product_id, quantity, customer_name, customer_phone, customer_address, remark } = req.body;
    if (!product_id || !customer_name || !customer_phone || !customer_address) {
      return res.status(400).json({ error: '请填写完整的收货信息' });
    }
    const product = await get("SELECT * FROM products WHERE id = ? AND status = 'active'", [product_id]);
    if (!product) return res.status(400).json({ error: '商品不存在' });
    const qty = quantity || 1;
    if (product.stock < qty) return res.status(400).json({ error: '库存不足' });

    const totalPrice = +(product.price * qty).toFixed(2);
    const orderNo = genOrderNo();
    const agentId = req.customer.agentId;

    const chain = await getAgentChain(agentId);
    const agentPath = JSON.stringify(chain.map(a => a.id));
    const directAgent = chain[0];

    // 计算佣金
    const commissions = [];
    const directCommission = +(totalPrice * directAgent.commission_rate).toFixed(2);
    commissions.push({ agent_id: directAgent.id, agent_name: directAgent.name, amount: directCommission, rate: directAgent.commission_rate, level: 'direct' });
    for (let i = 0; i < chain.length - 1; i++) {
      const child = chain[i];
      const parent = chain[i + 1];
      const indirectRate = +(parent.commission_rate - child.commission_rate).toFixed(4);
      if (indirectRate > 0) {
        const indirectCommission = +(totalPrice * indirectRate).toFixed(2);
        commissions.push({ agent_id: parent.id, agent_name: parent.name, amount: indirectCommission, rate: indirectRate, level: 'indirect' });
      }
    }

    // 创建订单
    const orderResult = await run(
      'INSERT INTO orders (order_no, product_id, product_name, product_price, quantity, total_price, customer_name, customer_phone, customer_address, remark, invite_code, agent_id, agent_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [orderNo, product.id, product.name, product.price, qty, totalPrice, customer_name, customer_phone, customer_address, remark || null, req.customer.invite_code, agentId, agentPath, 'pending']
    );

    // 扣减库存
    await run('UPDATE products SET stock = stock - ? WHERE id = ?', [qty, product.id]);

    // 创建佣金记录
    for (const c of commissions) {
      await run('INSERT INTO commissions (order_id, order_no, agent_id, agent_name, amount, rate, level) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderResult.lastInsertRowid, orderNo, c.agent_id, c.agent_name, c.amount, c.rate, c.level]);
    }

    // 发送通知
    const notifyTitle = `新订单：${orderNo}`;
    const notifyContent = `客户 ${customer_name} 下单了 ${product.name} x${qty}，请及时跟进`;
    await notify(directAgent.id, 'order', notifyTitle, notifyContent, orderResult.lastInsertRowid);
    for (let i = 1; i < chain.length; i++) {
      await notify(chain[i].id, 'order', `下级订单：${orderNo}`,
        `您的下级代理 ${chain[i-1].name} 的客户下单了 ${product.name} x${qty}`, orderResult.lastInsertRowid);
    }
    const adminUser = await get("SELECT id FROM users WHERE role = 'admin'");
    const adminInChain = chain.some(c => c.role === 'admin');
    if (adminUser && !adminInChain) {
      await notify(adminUser.id, 'order', `新订单待发货：${orderNo}`,
        `客户 ${customer_name} 下单 ${product.name} x${qty}，总价 ¥${totalPrice}，请尽快发货`, orderResult.lastInsertRowid);
    }

    res.json({ success: true, order_no: orderNo, message: '下单成功！我们将在24小时内发货。' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 代理路由 ============

// 获取代理个人信息
app.get('/api/agent/profile', auth('agent2'), async (req, res) => {
  try {
    const user = await get('SELECT id, username, name, phone, role, parent_id, commission_rate, invite_code, created_at FROM users WHERE id = ?', [req.user.id]);
    let parent = null;
    if (user.parent_id) {
      parent = await get('SELECT id, name, commission_rate FROM users WHERE id = ?', [user.parent_id]);
    }
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.json({
      ...user, parent,
      invite_link: `${baseUrl}/shop.html?code=${user.invite_code}`,
      register_link: `${baseUrl}/system.html#/register?code=${user.invite_code}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 获取下级代理列表
app.get('/api/agent/sub-agents', auth('agent2'), async (req, res) => {
  try {
    if (req.user.role !== 'agent1') return res.json([]);
    const subs = await all("SELECT id, username, name, phone, commission_rate, invite_code, status, created_at FROM users WHERE parent_id = ? AND role = 'agent2' ORDER BY created_at DESC", [req.user.id]);
    const result = [];
    for (const s of subs) {
      const stats = await get('SELECT COUNT(*) as order_count, COALESCE(SUM(amount),0) as total_commission FROM commissions WHERE agent_id = ? AND level = ?', [s.id, 'direct']);
      result.push({ ...s, order_count: stats.order_count, total_commission: stats.total_commission });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 一级代理设置二级代理佣金
app.put('/api/agent/sub-agents/:id/commission', auth('agent1'), async (req, res) => {
  try {
    const { rate } = req.body;
    if (rate == null || rate < 0 || rate > 1) return res.status(400).json({ error: '佣金比例无效' });
    const sub = await get("SELECT * FROM users WHERE id = ? AND parent_id = ? AND role = 'agent2'", [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ error: '下级代理不存在' });
    const agent1 = await get('SELECT commission_rate FROM users WHERE id = ?', [req.user.id]);
    const minRate = +(agent1.commission_rate / 1.3).toFixed(4);
    if (rate < minRate) {
      return res.status(400).json({ error: `佣金比例不能低于 ${(minRate * 100).toFixed(1)}%，您最多抽取下级代理佣金的30%` });
    }
    if (rate > agent1.commission_rate) {
      return res.status(400).json({ error: `二级代理佣金比例不能超过您的佣金比例 ${(agent1.commission_rate * 100).toFixed(1)}%` });
    }
    await run('UPDATE users SET commission_rate = ? WHERE id = ?', [rate, sub.id]);
    res.json({ success: true, message: '佣金比例已更新' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理获取订单列表
app.get('/api/agent/orders', auth('agent2'), async (req, res) => {
  try {
    const agentId = req.user.id;
    const role = req.user.role;
    let orders = [];

    if (role === 'agent1') {
      const subIds = (await all("SELECT id FROM users WHERE parent_id = ? AND role = 'agent2'", [agentId])).map(s => s.id);
      const allIds = [agentId, ...subIds];
      const placeholders = allIds.map((_, i) => `$${i + 1}`).join(',');
      orders = await all(`SELECT o.id, o.order_no, o.product_name, o.quantity, o.customer_name, o.customer_phone, o.status, o.tracking_no, o.tracking_company, o.created_at, o.shipped_at, o.agent_id FROM orders o WHERE o.agent_id IN (${placeholders}) ORDER BY o.created_at DESC`, allIds);
      for (const o of orders) {
        const agent = await get('SELECT name FROM users WHERE id = ?', [o.agent_id]);
        o.agent_name = agent ? agent.name : '';
        const comm = await get('SELECT amount, level FROM commissions WHERE order_id = ? AND agent_id = ?', [o.id, agentId]);
        o.my_commission = comm ? comm.amount : 0;
        o.commission_level = comm ? comm.level : null;
      }
    } else {
      orders = await all(`SELECT o.id, o.order_no, o.product_name, o.quantity, o.customer_name, o.customer_phone, o.status, o.tracking_no, o.tracking_company, o.created_at, o.shipped_at FROM orders o WHERE o.agent_id = ? ORDER BY o.created_at DESC`, [agentId]);
      for (const o of orders) {
        const comm = await get('SELECT amount, level FROM commissions WHERE order_id = ? AND agent_id = ?', [o.id, agentId]);
        o.my_commission = comm ? comm.amount : 0;
      }
    }
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理获取佣金统计
app.get('/api/agent/commissions/summary', auth('agent2'), async (req, res) => {
  try {
    const agentId = req.user.id;
    const direct = await get("SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM commissions WHERE agent_id = ? AND level = 'direct'", [agentId]);
    const indirect = await get("SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM commissions WHERE agent_id = ? AND level = 'indirect'", [agentId]);
    const pending = await get("SELECT COALESCE(SUM(amount),0) as total FROM commissions WHERE agent_id = ? AND status = 'pending'", [agentId]);
    const settled = await get("SELECT COALESCE(SUM(amount),0) as total FROM commissions WHERE agent_id = ? AND status = 'settled'", [agentId]);
    res.json({
      direct_count: parseInt(direct.count), direct_total: +direct.total.toFixed(2),
      indirect_count: parseInt(indirect.count), indirect_total: +indirect.total.toFixed(2),
      pending_total: +pending.total.toFixed(2), settled_total: +settled.total.toFixed(2),
      grand_total: +(direct.total + indirect.total).toFixed(2)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理获取佣金明细
app.get('/api/agent/commissions', auth('agent2'), async (req, res) => {
  try {
    const agentId = req.user.id;
    const list = await all(`
      SELECT c.id, c.order_no, c.amount, c.rate, c.level, c.status, c.created_at,
             o.product_name, o.customer_name, o.status as order_status
      FROM commissions c LEFT JOIN orders o ON c.order_id = o.id
      WHERE c.agent_id = ? ORDER BY c.created_at DESC`, [agentId]);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理获取通知
app.get('/api/agent/notifications', auth('agent2'), async (req, res) => {
  try {
    const list = await all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
    const unread = await get('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
    res.json({ list, unread_count: parseInt(unread.c) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agent/notifications/:id/read', auth('agent2'), async (req, res) => {
  try {
    await run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agent/notifications/read-all', auth('agent2'), async (req, res) => {
  try {
    await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 管理员路由 ============

// 管理员仪表盘
app.get('/api/admin/dashboard', auth('admin'), async (req, res) => {
  try {
    const totalOrders = parseInt((await get('SELECT COUNT(*) as c FROM orders')).c);
    const pendingOrders = parseInt((await get("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'")).c);
    const shippedOrders = parseInt((await get("SELECT COUNT(*) as c FROM orders WHERE status = 'shipped'")).c);
    const totalRevenue = (await get("SELECT COALESCE(SUM(total_price),0) as t FROM orders WHERE status != ?", ['cancelled'])).t;
    const totalCommissions = (await get('SELECT COALESCE(SUM(amount),0) as t FROM commissions')).t;
    const agent1Count = parseInt((await get("SELECT COUNT(*) as c FROM users WHERE role = 'agent1'")).c);
    const agent2Count = parseInt((await get("SELECT COUNT(*) as c FROM users WHERE role = 'agent2'")).c);
    const productCount = parseInt((await get("SELECT COUNT(*) as c FROM products WHERE status = 'active'")).c);

    // 最近7天订单趋势（PostgreSQL 语法）
    const trend = await all(`
      SELECT DATE(created_at::timestamp) as date, COUNT(*) as count, COALESCE(SUM(total_price),0) as revenue
      FROM orders WHERE created_at::timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at::timestamp) ORDER BY date`, []);

    res.json({
      totalOrders, pendingOrders, shippedOrders,
      totalRevenue: +totalRevenue.toFixed(2),
      totalCommissions: +totalCommissions.toFixed(2),
      agent1Count, agent2Count, productCount, trend
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品管理 - 列表
app.get('/api/admin/products', auth('admin'), async (req, res) => {
  try {
    const products = await all('SELECT * FROM products ORDER BY id DESC', []);
    res.json(products.map(formatProduct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品管理 - 新增
app.post('/api/admin/products', auth('admin'), async (req, res) => {
  try {
    const { name, description, price, images, stock, detail } = req.body;
    if (!name || price == null) return res.status(400).json({ error: '请填写商品名称和价格' });
    const imageJson = JSON.stringify(Array.isArray(images) ? images.filter(u => u.trim()) : (images ? [images] : []));
    const result = await run('INSERT INTO products (name, description, price, image, stock, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [name, description || '', price, imageJson, stock || 0, detail || '']);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品管理 - 更新
app.put('/api/admin/products/:id', auth('admin'), async (req, res) => {
  try {
    const { name, description, price, images, stock, detail, status } = req.body;
    const imageJson = JSON.stringify(Array.isArray(images) ? images.filter(u => u.trim()) : (images ? [images] : []));
    await run('UPDATE products SET name=?, description=?, price=?, image=?, stock=?, detail=?, status=? WHERE id=?',
      [name, description || '', price, imageJson, stock || 0, detail || '', status || 'active', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品管理 - 删除（软删除）
app.delete('/api/admin/products/:id', auth('admin'), async (req, res) => {
  try {
    await run("UPDATE products SET status = 'inactive' WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品上下架
app.put('/api/admin/products/:id/toggle', auth('admin'), async (req, res) => {
  try {
    const product = await get('SELECT status FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).json({ error: '商品不存在' });
    const newStatus = product.status === 'active' ? 'inactive' : 'active';
    await run('UPDATE products SET status = ? WHERE id = ?', [newStatus, req.params.id]);
    res.json({ success: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理管理 - 列表
app.get('/api/admin/agents', auth('admin'), async (req, res) => {
  try {
    const agents = await all(`
      SELECT u.id, u.username, u.name, u.phone, u.role, u.commission_rate, u.invite_code, u.status, u.created_at, u.parent_id,
        p.name as parent_name
      FROM users u LEFT JOIN users p ON u.parent_id = p.id
      WHERE u.role IN ('agent1','agent2') AND u.status != 'deleted' ORDER BY u.role DESC, u.created_at DESC`, []);
    const result = [];
    for (const a of agents) {
      const stats = await get('SELECT COUNT(*) as order_count, COALESCE(SUM(amount),0) as comm_total FROM commissions WHERE agent_id = ?', [a.id]);
      const subCount = a.role === 'agent1' ? parseInt((await get("SELECT COUNT(*) as c FROM users WHERE parent_id = ? AND role = 'agent2'", [a.id])).c) : 0;
      result.push({ ...a, order_count: parseInt(stats.order_count), commission_total: +stats.comm_total.toFixed(2), sub_agent_count: subCount });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 创建一级代理
app.post('/api/admin/agents', auth('admin'), async (req, res) => {
  try {
    const { username, password, name, phone, commission_rate } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: '请填写完整信息' });
    if (commission_rate == null || commission_rate < 0 || commission_rate > 1) return res.status(400).json({ error: '佣金比例无效' });
    const admin = await get("SELECT id, commission_rate FROM users WHERE role = 'admin'");
    if (commission_rate > admin.commission_rate) return res.status(400).json({ error: `代理佣金不能超过您的佣金比例 ${(admin.commission_rate*100).toFixed(1)}%` });
    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ error: '用户名已存在' });
    const salt = bcrypt.genSaltSync(10);
    const inviteCode = genInviteCode();
    const sql = "INSERT INTO users (username, password, name, phone, role, parent_id, commission_rate, invite_code) VALUES (?, ?, ?, ?, 'agent1', ?, ?, ?)";
    const result = await run(sql, [username, bcrypt.hashSync(password, salt), name, phone || null, admin.id, commission_rate, inviteCode]);
    res.json({ success: true, id: result.lastInsertRowid, invite_code: inviteCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 设置代理佣金比例
app.put('/api/admin/agents/:id/commission', auth('admin'), async (req, res) => {
  try {
    const { rate } = req.body;
    if (rate == null || rate < 0 || rate > 1) return res.status(400).json({ error: '佣金比例无效' });
    const agent = await get("SELECT * FROM users WHERE id = ? AND role IN ('agent1','agent2')", [req.params.id]);
    if (!agent) return res.status(404).json({ error: '代理不存在' });
    await run('UPDATE users SET commission_rate = ? WHERE id = ?', [rate, agent.id]);
    if (agent.role === 'agent1') {
      const subs = await all("SELECT id, commission_rate FROM users WHERE parent_id = ? AND role = 'agent2'", [agent.id]);
      const minRate = +(rate / 1.3).toFixed(4);
      for (const s of subs) {
        if (s.commission_rate < minRate) {
          await run('UPDATE users SET commission_rate = ? WHERE id = ?', [minRate, s.id]);
        }
      }
    }
    res.json({ success: true, message: '佣金比例已更新' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 禁用/启用代理
app.put('/api/admin/agents/:id/status', auth('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    await run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 注销代理
app.delete('/api/admin/agents/:id', auth('admin'), async (req, res) => {
  try {
    const agent = await get("SELECT id, name, role, parent_id FROM users WHERE id = ? AND role IN ('agent1','agent2')", [req.params.id]);
    if (!agent) return res.status(404).json({ error: '代理不存在' });
    if (agent.role === 'agent1') {
      const subs = await all("SELECT id FROM users WHERE parent_id = ?", [agent.id]);
      for (const s of subs) {
        await run("UPDATE users SET status = 'deleted' WHERE id = ?", [s.id]);
      }
    }
    await run("UPDATE users SET status = 'deleted' WHERE id = ?", [agent.id]);
    res.json({ success: true, message: `已注销代理「${agent.name}」${agent.role === 'agent1' ? '及其所有下级代理' : ''}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 重新生成邀请码
app.put('/api/admin/agents/:id/regenerate-code', auth('admin'), async (req, res) => {
  try {
    const user = await get("SELECT id, role FROM users WHERE id = ? AND role IN ('admin','agent1','agent2')", [req.params.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    let newCode;
    let attempts = 0;
    do {
      newCode = genInviteCode();
      attempts++;
    } while (await get('SELECT id FROM users WHERE invite_code = ?', [newCode]) && attempts < 10);
    await run('UPDATE users SET invite_code = ? WHERE id = ?', [newCode, req.params.id]);
    res.json({ success: true, invite_code: newCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 订单管理 - 列表
app.get('/api/admin/orders', auth('admin'), async (req, res) => {
  try {
    const orders = await all(`
      SELECT o.*, u.name as agent_name, u.role as agent_role
      FROM orders o LEFT JOIN users u ON o.agent_id = u.id
      ORDER BY o.created_at DESC`, []);
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 发货（录入快递单号）
app.put('/api/admin/orders/:id/ship', auth('admin'), async (req, res) => {
  try {
    const { tracking_no, tracking_company } = req.body;
    if (!tracking_no) return res.status(400).json({ error: '请输入快递单号' });
    const order = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'pending') return res.status(400).json({ error: '该订单已发货或已取消' });

    await run("UPDATE orders SET status = 'shipped', tracking_no = ?, tracking_company = ?, shipped_at = to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?",
      [tracking_no, tracking_company || '', req.params.id]);

    await run("UPDATE commissions SET status = 'settled' WHERE order_id = ?", [req.params.id]);

    const chain = await getAgentChain(order.agent_id);
    const directAgent = chain[0];
    const title = `订单已发货：${order.order_no}`;
    const content = `快递公司：${tracking_company || '未知'}，快递单号：${tracking_no}，请及时转发给客户`;
    await notify(directAgent.id, 'shipping', title, content, order.id);
    for (let i = 1; i < chain.length; i++) {
      await notify(chain[i].id, 'shipping', `下级订单已发货：${order.order_no}`,
        `快递单号：${tracking_no}（来自下级代理 ${chain[i-1].name} 的客户订单）`, order.id);
    }

    res.json({ success: true, message: '发货成功，已通知代理' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员获取通知
app.get('/api/admin/notifications', auth('admin'), async (req, res) => {
  try {
    const admin = await get("SELECT id FROM users WHERE role = 'admin'");
    const list = await all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [admin.id]);
    const unread = await get('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', [admin.id]);
    res.json({ list, unread_count: parseInt(unread.c) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/notifications/:id/read', auth('admin'), async (req, res) => {
  try {
    const admin = await get("SELECT id FROM users WHERE role = 'admin'");
    await run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, admin.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/notifications/read-all', auth('admin'), async (req, res) => {
  try {
    const admin = await get("SELECT id FROM users WHERE role = 'admin'");
    await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [admin.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  塔罗牌分销系统已启动（PostgreSQL 版）`);
  console.log(`========================================`);
  console.log(`  分销系统:   http://localhost:${PORT}/system.html`);
  console.log(`  客户商城:   http://localhost:${PORT}/shop.html`);
  console.log(`========================================`);
  console.log(`  默认账号:`);
  console.log(`  管理员:   admin / admin123`);
  console.log(`  一级代理: agent1 / 123456`);
  console.log(`  二级代理: agent2 / 123456`);
  console.log(`========================================\n`);
});
