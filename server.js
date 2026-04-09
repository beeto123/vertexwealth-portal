require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Central wallet address
let centralWallet = "TXvYkLxZqWnRfHjKpLmNpQrStUvWxYz12345678";

function generateCode() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// Send email using SendGrid
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

function sendEmail(to, subject, text) {
  const msg = { to, from: process.env.EMAIL_USER, subject, text };
  sgMail.send(msg).catch(error => console.error('SendGrid error:', error?.response?.body || error.message));
}

function sendEmailReceipt(investorEmail, investorName, type, amount, status, planType = null) {
  let subject = '', message = '';
  if (type === 'deposit') {
    subject = `Deposit Confirmed - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\nYour deposit of $${amount} has been confirmed and added to your balance.`;
  } else if (type === 'roi') {
    subject = `ROI Added - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\n${planType ? `${planType} plan` : 'Profit'} of $${amount} added to your balance.`;
  } else if (type === 'withdraw_approved') {
    subject = `Withdrawal Approved - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\nYour withdrawal request of $${amount} has been approved and processed.`;
  } else if (type === 'withdraw_rejected') {
    subject = `Withdrawal Update - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\nYour withdrawal request of $${amount} has been rejected.\n\nReason: ${status}`;
  }
  sendEmail(investorEmail, subject, message);
}

// ============ INVESTOR API ============

app.post('/api/generate-code', async (req, res) => {
  const { name, email, initial_deposit } = req.body;
  const code = generateCode();
  const depositAmount = parseFloat(initial_deposit) || 0;

  // Insert investor
  const { error } = await supabase
    .from('investors')
    .insert([{ unique_code: code, name, email, balance: depositAmount }]);

  if (error) return res.json({ success: false, error: error.message });

  if (depositAmount > 0) {
    await supabase.from('transactions').insert([{
      investor_code: code, investor_name: name, type: 'deposit',
      amount: depositAmount, status: 'approved'
    }]);
    sendEmailReceipt(email, name, 'deposit', depositAmount, 'approved');
  }

  const loginMessage = `Hello ${name},\n\nYour unique 8-digit login code is: ${code}\n\nLogin here: https://vertexwealth-portal.onrender.com/login.html`;
  sendEmail(email, 'Vertex Wealth Group - Your Login Code', loginMessage);
  res.json({ success: true, code });
});

app.post('/api/login', async (req, res) => {
  const { code } = req.body;
  const { data: investor, error } = await supabase
    .from('investors').select('*').eq('unique_code', code).single();

  if (error || !investor) return res.json({ success: false, error: 'Invalid code' });
  req.session.investor = investor;
  res.json({ success: true, investor });
});

app.get('/api/dashboard', async (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const code = req.session.investor.unique_code;

  const { data: investor } = await supabase
    .from('investors').select('*').eq('unique_code', code).single();

  const { data: transactions } = await supabase
    .from('transactions').select('*').eq('investor_code', code).order('created_at', { ascending: false });

  res.json({
    success: true,
    investor: {
      name: investor.name, balance: investor.balance, roi_earned: investor.roi_earned,
      active_plan: investor.active_plan, plan_start_date: investor.plan_start_date,
      plan_end_date: investor.plan_end_date
    },
    transactions: transactions || [],
    centralWallet
  });
});

app.post('/api/investor/select-plan', async (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const { plan } = req.body;
  const code = req.session.investor.unique_code;
  const startDate = new Date();
  const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const { error } = await supabase
    .from('investors')
    .update({ active_plan: plan, plan_start_date: startDate, plan_end_date: endDate })
    .eq('unique_code', code);

  if (error) return res.json({ success: false });
  res.json({ success: true, plan, startDate, endDate });
});

app.get('/api/investor/chart-data', async (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const code = req.session.investor.unique_code;

  const { data: transactions } = await supabase
    .from('transactions').select('created_at, type, amount, status').eq('investor_code', code);

  const dailyMap = new Map();
  transactions?.forEach(tx => {
    const date = new Date(tx.created_at).toISOString().split('T')[0];
    let added = 0, removed = 0;
    if (tx.type === 'deposit' || tx.type === 'roi') added = tx.amount;
    if (tx.type === 'withdraw' && tx.status === 'approved') removed = tx.amount;
    if (!dailyMap.has(date)) dailyMap.set(date, { added: 0, removed: 0 });
    const entry = dailyMap.get(date);
    entry.added += added;
    entry.removed += removed;
  });

  let balance = 0;
  const chartData = Array.from(dailyMap.entries()).sort().map(([date, { added, removed }]) => {
    balance += added - removed;
    return { date, balance };
  });
  res.json({ success: true, data: chartData });
});

app.post('/api/withdraw', async (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const { amount, wallet_address } = req.body;
  const withdrawAmount = parseFloat(amount);
  const { unique_code: code, name, balance } = req.session.investor;

  if (balance < withdrawAmount) return res.json({ success: false, error: 'Insufficient balance' });

  await supabase.from('transactions').insert([{
    investor_code: code, investor_name: name, type: 'withdraw',
    amount: withdrawAmount, status: 'pending', wallet_address
  }]);
  res.json({ success: true, message: 'Withdrawal request submitted.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ============ ADMIN API ============

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: req.session.admin === true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.admin = false;
  res.json({ success: true });
});

app.get('/api/admin/investors', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('investors').select('*').order('id', { ascending: false });
  res.json(data || []);
});

app.post('/api/admin/add-deposit', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { investor_code, investor_name, amount, investor_email } = req.body;
  const depositAmount = parseFloat(amount);

  await supabase.rpc('increment_balance', { p_code: investor_code, p_amount: depositAmount });
  await supabase.from('transactions').insert([{
    investor_code, investor_name, type: 'deposit', amount: depositAmount, status: 'approved'
  }]);
  sendEmailReceipt(investor_email, investor_name, 'deposit', depositAmount, 'approved');
  res.json({ success: true });
});

app.post('/api/admin/add-roi', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { investor_code, investor_name, amount, investor_email, plan_type } = req.body;
  const roiAmount = parseFloat(amount);

  await supabase.rpc('increment_balance_and_roi', { p_code: investor_code, p_amount: roiAmount });
  await supabase.from('transactions').insert([{
    investor_code, investor_name, type: 'roi', amount: roiAmount, status: 'approved'
  }]);
  await supabase.from('roi_updates').insert([{ investor_code, amount: roiAmount, plan_type: plan_type || 'manual' }]);
  sendEmailReceipt(investor_email, investor_name, 'roi', roiAmount, 'approved', plan_type);
  res.json({ success: true });
});

app.post('/api/admin/process-auto-roi', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { data: investors } = await supabase.from('investors').neq('active_plan', 'none');
  const results = [];
  for (const inv of investors || []) {
    const startDate = new Date(inv.plan_start_date);
    const daysSinceStart = Math.floor((Date.now() - startDate) / (1000 * 60 * 60 * 24));
    let roiToAdd = 0, planType = '';
    if (inv.active_plan === 'daily') {
      roiToAdd = inv.balance * 0.05;
      planType = '5% Daily';
    } else if (inv.active_plan === 'weekly' && daysSinceStart >= 7 && daysSinceStart % 7 === 0) {
      roiToAdd = inv.balance * 0.35;
      planType = '35% Weekly';
    }
    if (roiToAdd > 0) {
      await supabase.rpc('increment_balance_and_roi', { p_code: inv.unique_code, p_amount: roiToAdd });
      await supabase.from('transactions').insert([{
        investor_code: inv.unique_code, investor_name: inv.name, type: 'roi', amount: roiToAdd, status: 'approved'
      }]);
      await supabase.from('roi_updates').insert([{ investor_code: inv.unique_code, amount: roiToAdd, plan_type: planType }]);
      sendEmailReceipt(inv.email, inv.name, 'roi', roiToAdd, 'approved', planType);
      results.push({ name: inv.name, amount: roiToAdd });
    }
  }
  res.json({ success: true, processed: results.length, results });
});

app.get('/api/admin/withdrawals', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { data } = await supabase
    .from('transactions')
    .select('*, investors(email)')
    .eq('type', 'withdraw')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/admin/approve-withdrawal', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { transaction_id, investor_code, amount, investor_email, investor_name } = req.body;

  await supabase.from('transactions').update({ status: 'approved' }).eq('id', transaction_id);
  await supabase.rpc('decrement_balance', { p_code: investor_code, p_amount: amount });
  sendEmailReceipt(investor_email, investor_name, 'withdraw_approved', amount, 'approved');
  res.json({ success: true });
});

app.post('/api/admin/reject-withdrawal', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { transaction_id, reason, investor_email, investor_name, amount } = req.body;

  await supabase.from('transactions').update({ status: 'rejected', rejection_reason: reason }).eq('id', transaction_id);
  sendEmailReceipt(investor_email, investor_name, 'withdraw_rejected', amount, reason);
  res.json({ success: true });
});

app.get('/api/admin/transactions', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('transactions').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/stats/total-roi', async (req, res) => {
  const { data } = await supabase.from('investors').select('roi_earned');
  const total = (data || []).reduce((sum, inv) => sum + (inv.roi_earned || 0), 0);
  res.json({ total_roi: total });
});

app.post('/api/admin/update-wallet', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  centralWallet = req.body.wallet_address;
  res.json({ success: true, wallet: centralWallet });
});

app.post('/api/admin/delete-investor', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { investor_code } = req.body;
  await supabase.from('transactions').delete().eq('investor_code', investor_code);
  await supabase.from('roi_updates').delete().eq('investor_code', investor_code);
  await supabase.from('investors').delete().eq('unique_code', investor_code);
  res.json({ success: true });
});

app.get('/api/central-wallet', (req, res) => {
  res.json({ wallet: centralWallet });
});

app.post('/api/submit-lead', async (req, res) => {
  const { name, email, phone, amount, source, message } = req.body;
  
  console.log('Lead received:', email);
  
  const adminEmail = process.env.EMAIL_USER;
  const emailBody = `New investor application:\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\nInvestment Amount: ${amount}\nSource: ${source}\nMessage: ${message || 'No message'}`;
  
  // Send to admin
  try {
    await sgMail.send({
      to: adminEmail,
      from: process.env.EMAIL_USER,
      subject: `New Investor Lead: ${name}`,
      text: emailBody
    });
    console.log('Admin email sent to:', adminEmail);
  } catch (err) {
    console.error('Admin email error:', err.response?.body || err.message);
  }
  
  // Send confirmation to applicant
  const confirmBody = `Hello ${name},\n\nThank you for your interest in Vertex Wealth Group.\n\nWe have received your application and will review it within 24-48 hours.\n\nThank you,\nVertex Wealth Group`;
  
  try {
    await sgMail.send({
      to: email,
      from: process.env.EMAIL_USER,
      subject: 'Thank you for your application - Vertex Wealth Group',
      text: confirmBody
    });
    console.log('Confirmation email sent to:', email);
  } catch (err) {
    console.error('Confirmation email error:', err.response?.body || err.message);
  }
  
  res.json({ success: true });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});