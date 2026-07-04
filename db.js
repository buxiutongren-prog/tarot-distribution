// db.js - PostgreSQL 数据库初始化与兼容层
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

// ============ SQL 兼容工具 ============
// 把 SQLite 的 ? 占位符替换为 PostgreSQL 的 $1,$2,...
function toPgSql(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// get：查询单行
async function get(sql, params = []) {
  const result = await pool.query(toPgSql(sql), params);
  return result.rows[0] || null;
}

// all：查询多行
async function all(sql, params = []) {
  const result = await pool.query(toPgSql(sql), params);
  return result.rows;
}

// run：执行写入，自动处理 INSERT 的 RETURNING id
async function run(sql, params = []) {
  const pgSql = toPgSql(sql);
  // 如果是 INSERT 且没有 RETURNING，自动加上
  let finalSql = pgSql;
  if (/^\s*INSERT\s+INTO/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
    finalSql = pgSql + ' RETURNING id';
  }
  const result = await pool.query(finalSql, params);
  return {
    lastInsertRowid: result.rows[0]?.id ?? null,
    changes: result.rowCount
  };
}

// query：直接执行原始查询（用于复杂场景）
async function query(sql, params = []) {
  return await pool.query(toPgSql(sql), params);
}

// ============ 建表 ============
async function initDb() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'agent2',
      parent_id INTEGER DEFAULT NULL,
      commission_rate REAL DEFAULT 0,
      invite_code TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      image TEXT,
      stock INTEGER DEFAULT 999,
      detail TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_no TEXT UNIQUE NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      product_price REAL NOT NULL,
      quantity INTEGER DEFAULT 1,
      total_price REAL NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_address TEXT NOT NULL,
      remark TEXT,
      invite_code TEXT,
      agent_id INTEGER,
      agent_path TEXT,
      status TEXT DEFAULT 'pending',
      tracking_no TEXT,
      tracking_company TEXT,
      created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      shipped_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS commissions (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      order_no TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      amount REAL NOT NULL,
      rate REAL NOT NULL,
      level TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      order_id INTEGER,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    )`
  ];
  for (const sql of ddl) {
    await pool.query(sql);
  }
  console.log('[DB] 表结构已确认（PostgreSQL）');
}

// ============ 种子数据 ============
async function seedData() {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM users');
  if (parseInt(rows[0].c) > 0) return;

  const salt = bcrypt.genSaltSync(10);
  const hash = (pw) => bcrypt.hashSync(pw, salt);

  // 管理员
  await pool.query(
    `INSERT INTO users (username, password, name, role, commission_rate, invite_code)
     VALUES ($1, $2, $3, 'admin', $4, $5)`,
    ['admin', hash('admin123'), '系统管理员', 0.25, 'ADMIN0001']
  );

  // 一级代理（parent_id = 1 管理员）
  const agent1Res = await pool.query(
    `INSERT INTO users (username, password, name, phone, role, parent_id, commission_rate, invite_code)
     VALUES ($1, $2, $3, $4, 'agent1', $5, $6, $7) RETURNING id`,
    ['agent1', hash('123456'), '张一级', '13800001111', 1, 0.20, 'TAROT8A1']
  );
  const agent1Id = agent1Res.rows[0].id;

  // 二级代理
  await pool.query(
    `INSERT INTO users (username, password, name, phone, role, parent_id, commission_rate, invite_code)
     VALUES ($1, $2, $3, $4, 'agent2', $5, $6, $7)`,
    ['agent2', hash('123456'), '李二级', '13800002222', agent1Id, 0.15, 'TAROT8B2']
  );

  // 示例商品
  const products = [
    { name: '韦特塔罗牌（经典版）', description: '最经典的塔罗牌版本，78张完整牌组，适合初学者与收藏者', price: 128, image: '[]', stock: 200,
      detail: '韦特塔罗牌是世界上最流行的塔罗牌版本之一，由A.E.韦特设计，帕梅拉·科尔曼·史密斯绘制。包含22张大阿卡纳和56张小阿卡纳，共78张。\n\n规格：78张\n尺寸：70mm×120mm\n材质：350g蓝芯纸\n附赠：说明书一本' },
    { name: '透特塔罗牌（进阶版）', description: '克劳利与哈里斯夫人合作的经典之作，神秘学爱好者首选', price: 168, image: '[]', stock: 150,
      detail: '透特塔罗牌由阿莱斯特·克劳利设计，弗里达·哈里斯夫人绘制。融合了占星术、卡巴拉、炼金术等多种神秘学体系，画面抽象而富有力量感。\n\n规格：78张\n尺寸：70mm×120mm\n材质：350g蓝芯纸\n附赠：解读手册' },
    { name: '花影塔罗牌（唯美版）', description: '画风唯美细腻，色彩柔和，深受女性用户喜爱', price: 148, image: '[]', stock: 180,
      detail: '花影塔罗牌以精美的花卉与自然元素为主题，画风梦幻浪漫。每一张牌都是一幅独立的艺术品，既可用于占卜，也可作为收藏。\n\n规格：78张\n尺寸：70mm×120mm\n材质：350g蓝芯纸\n附赠：花语解读手册' },
    { name: '马赛塔罗牌（复古版）', description: '最古老的塔罗牌体系之一，复古木刻风格', price: 118, image: '[]', stock: 100,
      detail: '马赛塔罗牌源自18世纪法国，是塔罗牌的古典形态。采用传统木刻风格，线条简洁有力，适合研究塔罗历史与古典占卜的爱好者。\n\n规格：78张\n尺寸：65mm×115mm\n材质：330g蓝芯纸\n附赠：历史说明册' },
    { name: 'Universal Waite 塔罗牌（彩色版）', description: '韦特塔罗的彩色重制版，色彩更加鲜艳饱满', price: 138, image: '[]', stock: 160,
      detail: 'Universal Waite 塔罗牌在原版韦特塔罗的基础上，由玛丽·汉森-罗伯茨重新上色，色彩更加明亮柔和，细节更加丰富，是韦特塔罗的最佳升级版。\n\n规格：78张\n尺寸：70mm×120mm\n材质：350g蓝芯纸\n附赠：彩色说明书' },
    { name: '魔法师塔罗牌（限量版）', description: '限量发售，烫金工艺，附赠专属丝绒牌袋', price: 268, image: '[]', stock: 50,
      detail: '魔法师塔罗牌采用高端烫金工艺，牌背为精美魔法阵图案。每副附赠黑色丝绒牌袋一个，限量发售500副，编号收藏。\n\n规格：78张\n尺寸：75mm×130mm\n材质：400g黑芯纸+烫金\n附赠：丝绒牌袋+编号证书' },
  ];
  for (const p of products) {
    await pool.query(
      `INSERT INTO products (name, description, price, image, stock, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.name, p.description, p.price, p.image, p.stock, p.detail]
    );
  }

  console.log('[DB] 种子数据已初始化');
}

// 测试连接
async function testConnection() {
  try {
    await pool.query('SELECT 1');
    console.log('[DB] PostgreSQL 连接成功');
  } catch (e) {
    console.error('[DB] PostgreSQL 连接失败:', e.message);
    process.exit(1);
  }
}

testConnection().then(() => initDb()).then(() => seedData()).catch(console.error);

module.exports = { pool, get, all, run, query };
