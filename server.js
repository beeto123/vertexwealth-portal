require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const db = require('./database');

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

// SendGrid setup
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Central wallet address
let centralWallet = "TXvYkLxZqWnRfHjKpLmNpQrStUvWxYz12345678";

function generateCode() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// Send email using SendGrid (background)
function sendEmail(to, subject, text) {
  const msg = {
    to: to,
    from: process.env.EMAIL_USER,
    subject: subject,
    text: text
  };
  
  sgMail.send(msg).catch(error => {
    console.error('SendGrid error:', error.response?.body || error.message);
  });
}

function sendEmailReceipt(investorEmail, investorName, type, amount, status, planType = null) {
  let subject = '';
  let message = '';

  if (type === 'deposit') {
    subject = `Deposit Confirmed - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\nYour deposit of $${amount} has been confirmed and added to your balance.\n\nThank you for investing with Vertex Wealth Group.`;
  } else if (type === 'roi') {
    subject = `ROI Added to Your Account - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\n${planType ? `${planType} plan` : 'Profit'} of $${amount} has been added to your balance.\n\nThank you for trusting Vertex Wealth Group.`;
  } else if (type === 'withdraw_approved') {
    subject = `Withdrawal Approved - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\nYour withdrawal request of $${amount} has been approved and processed.\n\nFunds have been sent to your USDT wallet.`;
  } else if (type === 'withdraw_rejected') {
    subject = `Withdrawal Update - Vertex Wealth Group`;
    message = `Hello ${investorName},\n\nYour withdrawal request of $${amount} has been rejected.\n\nReason: ${status}\n\nPlease contact support.`;
  }

  sendEmail(investorEmail, subject, message);
}

// ============ INVESTOR API ============

app.post('/api/generate-code', (req, res) => {
  const { name, email, initial_deposit } = req.body;
  const code = generateCode();
  const depositAmount = parseFloat(initial_deposit) || 0;

  db.run(
    'INSERT INTO investors (unique_code, name, email, balance) VALUES (?, ?, ?, ?)',
    [code, name, email, depositAmount],
    (err) => {
      if (err) return res.json({ success: false, error: err.message });

      if (depositAmount > 0) {
        db.run('INSERT INTO transactions (investor_code, investor_name, type, amount, status) VALUES (?, ?, ?, ?, ?)',
          [code, name, 'deposit', depositAmount, 'approved']);
        sendEmailReceipt(email, name, 'deposit', depositAmount, 'approved');
      }

      // Send login code email
      const message = `Hello ${name},\n\nYour unique 8-digit login code is: ${code}\n\nLogin here: https://vertexwealth-portal.onrender.com/login.html\n\nKeep this code private.\n\nThank you for investing with Vertex Wealth Group.`;
      
      sendEmail(email, 'Vertex Wealth Group - Your Login Code', message);

      res.json({ success: true, code });
    }
  );
});

// [The rest of your server.js remains exactly the same - all other endpoints]
// (Keep your existing admin endpoints, withdrawal handling, etc.)

app.post('/api/login', (req, res) => {
  const { code } = req.body;
  db.get('SELECT * FROM investors WHERE unique_code = ?', [code], (err, investor) => {
    if (err || !investor) return res.json({ success: false, error: 'Invalid code' });
    req.session.investor = investor;
    res.json({ success: true, investor });
  });
});

app.get('/api/dashboard', (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const code = req.session.investor.unique_code;
  db.get('SELECT * FROM investors WHERE unique_code = ?', [code], (err, investor) => {
    if (err) return res.json({ success: false });
    db.all('SELECT * FROM transactions WHERE investor_code = ? ORDER BY created_at DESC', [code], (err, transactions) => {
      res.json({
        success: true,
        investor: {
          name: investor.name,
          balance: investor.balance,
          roi_earned: investor.roi_earned,
          active_plan: investor.active_plan,
          plan_start_date: investor.plan_start_date,
          plan_end_date: investor.plan_end_date
        },
        transactions: transactions || [],
        centralWallet: centralWallet
      });
    });
  });
});

app.post('/api/investor/select-plan', (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const { plan } = req.body;
  const code = req.session.investor.unique_code;
  const startDate = new Date();
  let endDate = new Date();

  if (plan === 'daily') {
    endDate.setDate(endDate.getDate() + 30);
  } else if (plan === 'weekly') {
    endDate.setDate(endDate.getDate() + 30);
  } else {
    return res.json({ success: false, error: 'Invalid plan' });
  }

  db.run('UPDATE investors SET active_plan = ?, plan_start_date = ?, plan_end_date = ? WHERE unique_code = ?',
    [plan, startDate.toISOString(), endDate.toISOString(), code], (err) => {
      if (err) return res.json({ success: false });
      res.json({ success: true, plan, startDate, endDate });
    });
});

app.get('/api/investor/chart-data', (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const code = req.session.investor.unique_code;
  
  db.all(`SELECT DATE(created_at) as date, SUM(CASE WHEN type IN ('deposit', 'roi') THEN amount ELSE 0 END) as added,
          SUM(CASE WHEN type = 'withdraw' AND status = 'approved' THEN amount ELSE 0 END) as removed
          FROM transactions 
          WHERE investor_code = ? 
          GROUP BY DATE(created_at) 
          ORDER BY date ASC`, [code], (err, rows) => {
    if (err) return res.json({ success: false });
    
    let runningBalance = 0;
    const chartData = rows.map(row => {
      runningBalance += (row.added || 0) - (row.removed || 0);
      return { date: row.date, balance: runningBalance };
    });
    res.json({ success: true, data: chartData });
  });
});

app.post('/api/withdraw', (req, res) => {
  if (!req.session.investor) return res.json({ success: false, error: 'Not logged in' });
  const { amount, wallet_address } = req.body;
  const withdrawAmount = parseFloat(amount);
  const code = req.session.investor.unique_code;
  const name = req.session.investor.name;

  db.get('SELECT balance FROM investors WHERE unique_code = ?', [code], (err, investor) => {
    if (err || !investor) return res.json({ success: false, error: 'Investor not found' });
    if (investor.balance < withdrawAmount) return res.json({ success: false, error: 'Insufficient balance' });
    
    db.run('INSERT INTO transactions (investor_code, investor_name, type, amount, status, wallet_address) VALUES (?, ?, ?, ?, ?, ?)',
      [code, name, 'withdraw', withdrawAmount, 'pending', wallet_address]);
    res.json({ success: true, message: 'Withdrawal request submitted.' });
  });
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

app.get('/api/admin/investors', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  db.all('SELECT id, unique_code, name, email, balance, roi_earned, active_plan, created_at FROM investors ORDER BY id DESC', [], (err, investors) => {
    if (err) return res.json({ error: err.message });
    res.json(investors);
  });
});

app.post('/api/admin/add-deposit', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { investor_code, investor_name, amount, investor_email } = req.body;
  const depositAmount = parseFloat(amount);

  db.run('UPDATE investors SET balance = balance + ? WHERE unique_code = ?', [depositAmount, investor_code]);
  db.run('INSERT INTO transactions (investor_code, investor_name, type, amount, status) VALUES (?, ?, ?, ?, ?)',
    [investor_code, investor_name, 'deposit', depositAmount, 'approved']);
  sendEmailReceipt(investor_email, investor_name, 'deposit', depositAmount, 'approved');
  res.json({ success: true });
});

app.post('/api/admin/add-roi', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { investor_code, investor_name, amount, investor_email, plan_type } = req.body;
  const roiAmount = parseFloat(amount);

  db.get('SELECT roi_earned FROM investors WHERE unique_code = ?', [investor_code], (err, investor) => {
    if (err || !investor) return res.json({ success: false });
    const newRoi = investor.roi_earned + roiAmount;
    db.run('UPDATE investors SET balance = balance + ?, roi_earned = ? WHERE unique_code = ?', [roiAmount, newRoi, investor_code]);
    db.run('INSERT INTO transactions (investor_code, investor_name, type, amount, status) VALUES (?, ?, ?, ?, ?)',
      [investor_code, investor_name, 'roi', roiAmount, 'approved']);
    db.run('INSERT INTO roi_updates (investor_code, amount, plan_type) VALUES (?, ?, ?)',
      [investor_code, roiAmount, plan_type || 'manual']);
    sendEmailReceipt(investor_email, investor_name, 'roi', roiAmount, 'approved', plan_type);
    res.json({ success: true });
  });
});

app.post('/api/admin/process-auto-roi', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  
  db.all('SELECT * FROM investors WHERE active_plan != "none"', [], (err, investors) => {
    if (err) return res.json({ error: err.message });
    
    const now = new Date();
    const results = [];
    
    investors.forEach(investor => {
      const startDate = new Date(investor.plan_start_date);
      const daysSinceStart = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
      let roiToAdd = 0;
      let planType = '';
      
      if (investor.active_plan === 'daily') {
        roiToAdd = investor.balance * 0.05;
        planType = '5% Daily';
      } else if (investor.active_plan === 'weekly') {
        if (daysSinceStart >= 7 && daysSinceStart % 7 === 0) {
          roiToAdd = investor.balance * 0.35;
          planType = '35% Weekly';
        }
      }
      
      if (roiToAdd > 0) {
        const newRoi = investor.roi_earned + roiToAdd;
        db.run('UPDATE investors SET balance = balance + ?, roi_earned = ? WHERE unique_code = ?', 
          [roiToAdd, newRoi, investor.unique_code]);
        db.run('INSERT INTO transactions (investor_code, investor_name, type, amount, status) VALUES (?, ?, ?, ?, ?)',
          [investor.unique_code, investor.name, 'roi', roiToAdd, 'approved']);
        db.run('INSERT INTO roi_updates (investor_code, amount, plan_type) VALUES (?, ?, ?)',
          [investor.unique_code, roiToAdd, planType]);
        sendEmailReceipt(investor.email, investor.name, 'roi', roiToAdd, 'approved', planType);
        results.push({ name: investor.name, amount: roiToAdd });
      }
    });
    
    res.json({ success: true, processed: results.length, results });
  });
});

app.get('/api/admin/withdrawals', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  db.all(`SELECT t.*, i.email FROM transactions t JOIN investors i ON t.investor_code = i.unique_code WHERE t.type = 'withdraw' AND t.status = 'pending' ORDER BY t.created_at DESC`, [], (err, withdrawals) => {
    if (err) return res.json({ error: err.message });
    res.json(withdrawals);
  });
});

app.post('/api/admin/approve-withdrawal', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { transaction_id, investor_code, amount, investor_email, investor_name } = req.body;

  db.run('UPDATE transactions SET status = ? WHERE id = ?', ['approved', transaction_id]);
  db.run('UPDATE investors SET balance = balance - ? WHERE unique_code = ?', [amount, investor_code]);
  sendEmailReceipt(investor_email, investor_name, 'withdraw_approved', amount, 'approved');
  res.json({ success: true });
});

app.post('/api/admin/reject-withdrawal', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { transaction_id, reason, investor_email, investor_name, amount } = req.body;

  db.run('UPDATE transactions SET status = ?, rejection_reason = ? WHERE id = ?', ['rejected', reason, transaction_id]);
  sendEmailReceipt(investor_email, investor_name, 'withdraw_rejected', amount, reason);
  res.json({ success: true });
});

app.get('/api/admin/transactions', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  db.all('SELECT * FROM transactions ORDER BY created_at DESC', [], (err, transactions) => {
    if (err) return res.json({ error: err.message });
    res.json(transactions);
  });
});

app.get('/api/stats/total-roi', (req, res) => {
  db.get('SELECT SUM(roi_earned) as total_roi FROM investors', [], (err, result) => {
    if (err) return res.json({ total_roi: 0 });
    res.json({ total_roi: result.total_roi || 0 });
  });
});

app.post('/api/admin/update-wallet', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { wallet_address } = req.body;
  centralWallet = wallet_address;
  res.json({ success: true, wallet: centralWallet });
});

app.post('/api/admin/delete-investor', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { investor_code } = req.body;
  
  db.run('DELETE FROM transactions WHERE investor_code = ?', [investor_code]);
  db.run('DELETE FROM roi_updates WHERE investor_code = ?', [investor_code]);
  db.run('DELETE FROM investors WHERE unique_code = ?', [investor_code], (err) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/central-wallet', (req, res) => {
  res.json({ wallet: centralWallet });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});