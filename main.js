const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { spawn, execSync }                             = require('child_process');
const path                                            = require('path');
const http                                            = require('http');
const fs                                              = require('fs');

// ── Backup Configuration ──────────────────────────────────────────────────────
const BACKUP_DIR = 'C:\\POS_Backups';
const KEEP_DAYS  = 7;

function backupDatabase() {
    try {
        const userDataPath = app.getPath('userData');
        const dbPath = fs.existsSync('C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite')
            ? 'C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite'
            : path.join(userDataPath, 'database.sqlite');

        if (!fs.existsSync(dbPath)) {
            console.warn('[Backup] Database not found:', dbPath);
            return;
        }

        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }

        const now       = new Date();
        const pad       = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const destFile  = path.join(BACKUP_DIR, `pos_backup_${timestamp}.sqlite`);

        fs.copyFileSync(dbPath, destFile);
        console.log('[Backup] Saved to:', destFile);

        const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
        fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('pos_backup_') && f.endsWith('.sqlite'))
            .forEach(f => {
                const full = path.join(BACKUP_DIR, f);
                if (fs.statSync(full).mtimeMs < cutoff) {
                    fs.unlinkSync(full);
                    console.log('[Backup] Deleted old backup:', f);
                }
            });

    } catch (err) {
        console.error('[Backup] Failed:', err.message);
    }
}

// ── Export Configuration ──────────────────────────────────────────────────────
const EXPORT_DIR  = 'C:\\POS_Backups\\Reports';
const DB_OVERRIDE = 'C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite';

async function exportReports() {
    try {
        const initSqlJs = require('sql.js');
        const userDataPath = app.getPath('userData');
        const dbPath = fs.existsSync(DB_OVERRIDE) ? DB_OVERRIDE : path.join(userDataPath, 'database.sqlite');

        if (!fs.existsSync(dbPath)) {
            console.warn('[Export] Database not found:', dbPath);
            return;
        }

        if (!fs.existsSync(EXPORT_DIR)) {
            fs.mkdirSync(EXPORT_DIR, { recursive: true });
        }

        const SQL      = await initSqlJs();
        const fileData = fs.readFileSync(dbPath);
        const db       = new SQL.Database(fileData);

        const query = (sql) => {
            try {
                const results = db.exec(sql);
                if (!results || results.length === 0) return [];
                const { columns, values } = results[0];
                return values.map(row => {
                    const obj = {};
                    columns.forEach((col, i) => { obj[col] = row[i] == null ? '' : String(row[i]); });
                    return obj;
                });
            } catch (e) {
                console.error('[Export] Query error:', e.message);
                return [];
            }
        };

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;

        const orders     = query(`SELECT id, invoice_no, receipt_no, tracking_no, total_amount, order_date, order_status, payment_mode, sales_rep FROM orders ORDER BY id DESC`);
        const orderItems = query(`SELECT oi.order_id, p.name AS product, oi.quantity, oi.price FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id`);
        const products   = query(`SELECT p.name, c.name AS category, p.cost, p.price, p.quantity, p.low_stock_limit, p.created_on FROM products p LEFT JOIN category c ON c.id = p.category_id ORDER BY p.name`);
        const customers  = query(`SELECT name, email, phone, company, location, credit_limit, credit_balance, created_on FROM customers ORDER BY name`);

        db.close();

        const XLSX = require('xlsx');
        const wb   = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders),     'Sales');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orderItems), 'Order Items');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(products),   'Inventory');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(customers),  'Customers');
        XLSX.writeFile(wb, path.join(EXPORT_DIR, `pos_report_${ts}.xlsx`));
        console.log('[Export] Excel saved.');

    } catch (err) {
        console.error('[Export] Fatal error:', err.message);
    }
}

// ── Custom Backup Popup ───────────────────────────────────────────────────────
// Shows the orangered HTML popup instead of the native dialog.
// Returns a Promise that resolves to: 0 = backup & close, 1 = just close, 2 = cancel
function showBackupPopup() {
    return new Promise((resolve) => {
        const popup = new BrowserWindow({
            width:           420,
            height:          420,
            resizable:       false,
            minimizable:     false,
            maximizable:     false,
            fullscreenable:  false,
            title:           'Backup',
            parent:          mainWindow,
            modal:           true,
            transparent:     true,
            frame:           false,
            icon:            path.join(__dirname, 'icon.ico'),
            backgroundColor: '#00000000',
            webPreferences: {
                nodeIntegration:  true,
                contextIsolation: false,
            },
            autoHideMenuBar: true,
        });

        popup.loadFile(path.join(__dirname, 'backup_popup.html'));

        // Listen for the button choice sent from the popup renderer
        ipcMain.once('backup-popup-response', (_, response) => {
            // Give the spinner a moment to show before closing
            setTimeout(() => {
                if (!popup.isDestroyed()) popup.close();
                resolve(response);
            }, response === 0 ? 300 : 0);
        });

        // If the user closes the window via OS (Alt+F4 etc.) treat as Cancel
        popup.on('closed', () => resolve(2));
    });
}

// ── Backup on close ───────────────────────────────────────────────────────────

const PORT    = 8000;
const HOST    = '127.0.0.1';
const APP_URL = `http://${HOST}:${PORT}`;

const BASE_PATH = app.isPackaged ? process.resourcesPath : __dirname;
const PHP_ROOT = path.join(BASE_PATH, 'sultan_pos');

let phpServer  = null;
let mainWindow = null;

function findPhp() {
    const arch      = process.arch;
    const phpFolder = arch === 'x64' ? 'php-x64' : 'php-x86';

    console.log('[Electron] Architecture:', arch);
    console.log('[Electron] Using PHP folder:', phpFolder);

    const candidates = [
        path.join(BASE_PATH, phpFolder, 'php.exe'),
        path.join(__dirname, phpFolder, 'php.exe'),
        path.join(BASE_PATH, 'php', 'php.exe'),
        path.join(__dirname, 'php', 'php.exe'),
        'php',
        'php8',
        'C:\\xampp\\php\\php.exe',
        'C:\\xampp7\\php\\php.exe',
        'C:\\wamp64\\bin\\php\\php8.2.12\\php.exe',
    ];

    for (const candidate of candidates) {
        try {
            execSync(`"${candidate}" -r "echo 1;"`, { stdio: 'ignore' });
            console.log('[Electron] PHP found at:', candidate);
            return candidate;
        } catch (_) {}
    }
    return null;
}

function startPhpServer(phpPath) {
    return new Promise((resolve, reject) => {
        console.log('[Electron] Starting PHP at:', phpPath);
        console.log('[Electron] Serving from:', PHP_ROOT);

        const userDataPath = app.getPath('userData');
        const targetDb = path.join(userDataPath, 'database.sqlite');
        const sourceDb = path.join(PHP_ROOT, 'database.sqlite');

        if (!fs.existsSync(targetDb) && fs.existsSync(sourceDb)) {
            try {
                fs.copyFileSync(sourceDb, targetDb);
                console.log('[Electron] Database copied to userData:', targetDb);
            } catch (err) {
                console.error('[Electron] Failed to copy database:', err.message);
            }
        }

        console.log('[Electron] Database path:', targetDb);

        phpServer = spawn(phpPath, ['-S', `${HOST}:${PORT}`, '-t', PHP_ROOT], {
            cwd: PHP_ROOT,
            windowsHide: true,
            env: { ...process.env, SULTAN_DB_PATH: userDataPath }
        });

        phpServer.stderr.on('data', (data) => {
            const msg = data.toString();
            console.log('[PHP]', msg.trim());
            if (msg.includes('Development Server') || msg.includes('started')) resolve();
        });

        phpServer.on('error', (err) => reject(new Error('PHP failed: ' + err.message)));
        phpServer.on('exit', (code) => {
            if (code !== 0 && code !== null) console.error('[PHP] exited with code', code);
        });

        setTimeout(resolve, 4000);
    });
}

function waitForServer(retries = 30, delay = 300) {
    return new Promise((resolve, reject) => {
        const attempt = (n) => {
            http.get(APP_URL, () => resolve()).on('error', () => {
                if (n <= 0) {
                    reject(new Error(
                        'PHP server did not respond in time.\n\n' +
                        'Make sure PHP is installed and accessible.\n' +
                        'Try running: php -S 127.0.0.1:8000 -t sultan_pos'
                    ));
                } else {
                    setTimeout(() => attempt(n - 1), delay);
                }
            });
        };
        attempt(retries);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width:  1280,
        height: 800,
        minWidth:  900,
        minHeight: 600,
        title: 'Sultan POS — Retail Management System',
        icon:  path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration:  false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        show: false,
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.maximize();
    });

    mainWindow.loadURL(`${APP_URL}/login.php`);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(APP_URL)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    // ── Backup on close — custom HTML popup ───────────────────────────────────
    mainWindow.on('close', async (e) => {
        e.preventDefault();

        const response = await showBackupPopup();
        // 0 = Yes backup & close, 1 = No just close, 2 = Cancel
        if (response === 2) return;

        if (response === 0) {
            backupDatabase();
            await exportReports();
        }

        mainWindow.destroy();
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    const phpPath = findPhp();

    if (!phpPath) {
        dialog.showErrorBox('PHP Not Found',
            'PHP could not be found.\n\n' +
            'Please install PHP 8+ and make sure it is on your system PATH,\n' +
            'or place php.exe inside the "php-x64/" or "php-x86/" folder next to this app.'
        );
        app.quit();
        return;
    }

    try {
        await startPhpServer(phpPath);
        await waitForServer();
        createWindow();
    } catch (err) {
        dialog.showErrorBox('Startup Error', err.message);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
    if (phpServer) { phpServer.kill(); phpServer = null; }
});

// ── Print Receipt ─────────────────────────────────────────────────────────────
ipcMain.on('print-receipt', (event, receiptHTML) => {
    const fullHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    width: 72mm;
    margin: 4mm;
    color: #000;
  }
  .r-title   { font-size: 14px; font-weight: 700; text-align: center; margin: 0 0 2px; }
  .r-sub     { font-size: 12px; text-align: center; margin: 0; }
  .r-center  { text-align: center; font-size: 12px; margin: 1px 0; }
  .r-bold    { font-weight: 700; font-size: 12px; margin: 3px 0 1px; }
  .r-divider { border-top: 1px dashed #000; margin: 5px 0; }
  .r-spacer  { height: 8px; }
  .r-line    { display: flex; justify-content: space-between; font-size: 12px; margin: 1px 0; }
</style>
</head>
<body>${receiptHTML}</body>
</html>`;

    const printWin = new BrowserWindow({
        width:  302,
        height: 800,
        show:   false,
        webPreferences: {
            nodeIntegration:  false,
            contextIsolation: true,
        },
    });

    printWin.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(fullHTML));

    printWin.webContents.once('did-finish-load', () => {
        printWin.webContents.print(
            {
                silent:          true,
                printBackground: false,
                margins:         { marginType: 'none' },
                pageSize:        { width: 80000, height: 297000 },
            },
            (success, failureReason) => {
                if (!success) console.error('[Electron] Print failed:', failureReason);
                event.reply('print-done', success);
                printWin.destroy();
            }
        );
    });

    printWin.webContents.once('did-fail-load', () => {
        console.error('[Electron] Receipt page failed to load.');
        event.reply('print-done', false);
        printWin.destroy();
    });
});


// ── Restore Handler ───────────────────────────────────────────────────────────
ipcMain.handle('restore-select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title:       'Select Backup File to Restore',
        defaultPath: 'C:\\POS_Backups',
        filters: [
            { name: 'Backup Files', extensions: ['sqlite', 'xlsx'] },
            { name: 'SQLite Database', extensions: ['sqlite'] },
            { name: 'Excel Report',   extensions: ['xlsx'] },
        ],
        properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('restore-from-sqlite', async (_, filePath) => {
    try {
        const initSqlJs    = require('sql.js');
        const userDataPath = app.getPath('userData');
        const dbDest = fs.existsSync('C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite')
            ? 'C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite'
            : path.join(userDataPath, 'database.sqlite');

        // ── Validate the file is a real SQLite database ───────────────────────
        const header = Buffer.alloc(16);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, header, 0, 16, 0);
        fs.closeSync(fd);
        const magic = header.slice(0, 16).toString('utf8');
        if (!magic.startsWith('SQLite format 3')) {
            return { success: false, message: 'The selected file is not a valid SQLite database. Please choose a .sqlite backup file.' };
        }

        // ── Test it can actually be opened ────────────────────────────────────
        try {
            const SQL      = await initSqlJs();
            const fileData = fs.readFileSync(filePath);
            const testDb   = new SQL.Database(fileData);
            testDb.exec('SELECT count(*) FROM sqlite_master');
            testDb.close();
        } catch(e) {
            return { success: false, message: 'The file appears corrupted and cannot be opened: ' + e.message };
        }

        // ── Safety backup of current DB ───────────────────────────────────────
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const safetyBackup = path.join(BACKUP_DIR, `pre_restore_${ts}.sqlite`);
        if (fs.existsSync(dbDest)) {
            fs.copyFileSync(dbDest, safetyBackup);
            console.log('[Restore] Safety backup saved to:', safetyBackup);
        }

        fs.copyFileSync(filePath, dbDest);
        console.log('[Restore] SQLite restored from:', filePath);
        return { success: true, message: 'Database restored successfully! Please restart the POS app.' };
    } catch (err) {
        console.error('[Restore] SQLite restore failed:', err.message);
        return { success: false, message: err.message };
    }
});

ipcMain.handle('restore-from-excel', async (_, filePath) => {
    try {
        const XLSX         = require('xlsx');
        const initSqlJs    = require('sql.js');
        const userDataPath = app.getPath('userData');
        const dbDest = fs.existsSync('C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite')
            ? 'C:\\Users\\Administrator\\AppData\\Roaming\\sultan-pos\\database.sqlite'
            : path.join(userDataPath, 'database.sqlite');

        // Safety backup first
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const safetyBackup = path.join(BACKUP_DIR, `pre_restore_${ts}.sqlite`);
        if (fs.existsSync(dbDest)) {
            fs.copyFileSync(dbDest, safetyBackup);
            console.log('[Restore] Safety backup saved to:', safetyBackup);
        }

        // Read Excel
        const wb     = XLSX.readFile(filePath);
        const sheets = wb.SheetNames;

        // Load current DB
        const SQL      = await initSqlJs();
        const fileData = fs.readFileSync(dbDest);
        const db       = new SQL.Database(fileData);

        // Helper: get all existing values for a column
        const getExisting = (table, col) => {
            try {
                const res = db.exec(`SELECT ${col} FROM ${table}`);
                if (!res.length) return new Set();
                return new Set(res[0].values.map(r => String(r[0]).toLowerCase().trim()));
            } catch(e) { return new Set(); }
        };

        // Helper: check if order_item already exists by order_id + product price + qty
        const getExistingItems = () => {
            try {
                const res = db.exec(`SELECT order_id, price, quantity FROM order_items`);
                if (!res.length) return new Set();
                return new Set(res[0].values.map(r => `${r[0]}_${r[1]}_${r[2]}`));
            } catch(e) { return new Set(); }
        };

        let salesInserted = 0, salesSkipped = 0;
        let productsInserted = 0, productsSkipped = 0;
        let customersInserted = 0, customersSkipped = 0;
        let itemsInserted = 0, itemsSkipped = 0;

        // ── Restore Sales (dedupe by invoice_no) ─────────────────────────────
        if (sheets.includes('Sales')) {
            const existingInvoices = getExisting('orders', 'invoice_no');
            const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sales']);
            rows.forEach(row => {
                const invoice = String(row['invoice_no'] || '').trim();
                if (!invoice || existingInvoices.has(invoice.toLowerCase())) {
                    salesSkipped++; return;
                }
                try {
                    db.run(`INSERT INTO orders (invoice_no, receipt_no, tracking_no, total_amount, order_date, order_status, payment_mode, sales_rep)
                            VALUES (?,?,?,?,?,?,?,?)`, [
                        row['invoice_no']   || '',
                        row['receipt_no']   || '',
                        row['tracking_no']  || '',
                        row['total_amount'] || '0',
                        row['order_date']   || '',
                        row['order_status'] || '',
                        row['payment_mode'] || '',
                        row['sales_rep']    || '',
                    ]);
                    existingInvoices.add(invoice.toLowerCase());
                    salesInserted++;
                } catch(e) { salesSkipped++; }
            });
        }

        // ── Restore Products (dedupe by name + price) ─────────────────────────
        if (sheets.includes('Inventory')) {
            const existingProducts = (() => {
                try {
                    const res = db.exec(`SELECT name, price FROM products`);
                    if (!res.length) return new Set();
                    return new Set(res[0].values.map(r => `${String(r[0]).toLowerCase().trim()}_${r[1]}`));
                } catch(e) { return new Set(); }
            })();
            const rows = XLSX.utils.sheet_to_json(wb.Sheets['Inventory']);
            rows.forEach(row => {
                const key = `${String(row['name'] || '').toLowerCase().trim()}_${row['price'] || ''}`;
                if (!row['name'] || existingProducts.has(key)) {
                    productsSkipped++; return;
                }
                try {
                    db.run(`INSERT INTO products (name, cost, price, quantity, low_stock_limit, created_on)
                            VALUES (?,?,?,?,?,?)`, [
                        row['name']            || '',
                        row['cost']            || '0',
                        row['price']           || '0',
                        row['quantity']        || '0',
                        row['low_stock_limit'] || '5',
                        row['created_on']      || '',
                    ]);
                    existingProducts.add(key);
                    productsInserted++;
                } catch(e) { productsSkipped++; }
            });
        }

        // ── Restore Customers (dedupe by phone OR email) ──────────────────────
        if (sheets.includes('Customers')) {
            const existingPhones = getExisting('customers', 'phone');
            const existingEmails = getExisting('customers', 'email');
            const rows = XLSX.utils.sheet_to_json(wb.Sheets['Customers']);
            rows.forEach(row => {
                const phone = String(row['phone'] || '').trim().toLowerCase();
                const email = String(row['email'] || '').trim().toLowerCase();
                if ((!phone && !email) ||
                    (phone && existingPhones.has(phone)) ||
                    (email && email !== '' && existingEmails.has(email))) {
                    customersSkipped++; return;
                }
                try {
                    db.run(`INSERT INTO customers (name, email, phone, company, location, credit_limit, credit_balance, created_on)
                            VALUES (?,?,?,?,?,?,?,?)`, [
                        row['name']           || '',
                        row['email']          || '',
                        row['phone']          || '',
                        row['company']        || '',
                        row['location']       || '',
                        row['credit_limit']   || '0',
                        row['credit_balance'] || '0',
                        row['created_on']     || '',
                    ]);
                    if (phone) existingPhones.add(phone);
                    if (email) existingEmails.add(email);
                    customersInserted++;
                } catch(e) { customersSkipped++; }
            });
        }

        // ── Restore Order Items (dedupe by order_id + price + qty) ────────────
        if (sheets.includes('Order Items')) {
            const existingItems = getExistingItems();
            const rows = XLSX.utils.sheet_to_json(wb.Sheets['Order Items']);
            rows.forEach(row => {
                const key = `${row['order_id']}_${row['price']}_${row['quantity']}`;
                if (!row['order_id'] || existingItems.has(key)) {
                    itemsSkipped++; return;
                }
                try {
                    db.run(`INSERT INTO order_items (order_id, price, quantity) VALUES (?,?,?)`, [
                        row['order_id'] || '',
                        row['price']    || '0',
                        row['quantity'] || '0',
                    ]);
                    existingItems.add(key);
                    itemsInserted++;
                } catch(e) { itemsSkipped++; }
            });
        }

        // Save DB back to a temp file first, validate, then replace
        const exported  = db.export();
        const tempPath  = dbDest + '.tmp';
        fs.writeFileSync(tempPath, Buffer.from(exported));
        db.close();

        // Validate the written file before replacing
        try {
            const SQL2      = await initSqlJs();
            const testData  = fs.readFileSync(tempPath);
            const testDb    = new SQL2.Database(testData);
            testDb.exec('SELECT count(*) FROM sqlite_master');
            testDb.close();
        } catch(e) {
            fs.unlinkSync(tempPath);
            return { success: false, message: 'Export validation failed — original database unchanged: ' + e.message };
        }

        // Safe to replace
        fs.copyFileSync(tempPath, dbDest);
        fs.unlinkSync(tempPath);

        const msg = [
            `Sales: ${salesInserted} added, ${salesSkipped} already existed`,
            `Products: ${productsInserted} added, ${productsSkipped} already existed`,
            `Customers: ${customersInserted} added, ${customersSkipped} already existed`,
            `Order Items: ${itemsInserted} added, ${itemsSkipped} already existed`,
        ].join('\n');

        console.log('[Restore]', msg);
        return { success: true, message: msg };
    } catch (err) {
        console.error('[Restore] Excel restore failed:', err.message);
        return { success: false, message: err.message };
    }
});


// ── Open Restore Window ───────────────────────────────────────────────────────
ipcMain.handle('open-restore-window', () => {
    const restoreWin = new BrowserWindow({
        width:  520,
        height: 680,
        title:  'Restore POS Data',
        resizable: false,
        parent: mainWindow,
        modal:  true,
        icon:   path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration:  true,
            contextIsolation: false,
        },
        autoHideMenuBar: true,
    });
    restoreWin.loadFile(path.join(__dirname, 'restore.html'));
});

// ── Open File Dialog ──────────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async (_, options) => {
    return await dialog.showOpenDialog(mainWindow, options);
});