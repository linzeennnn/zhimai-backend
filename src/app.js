const express = require('express');
const cors = require('cors');
const sequelize = require('./config/database');
require('dotenv').config();
const userService = require('./services/userService');
const scheduler = require('./utils/scheduler');
const logger = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const createRateLimiter = require('./middleware/rateLimiter');

const activityRoutes = require('./routes/activityRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const reminderRoutes = require('./routes/reminderRoutes');

const app = express();

// 配置 CORS
const corsOptions = {
    origin: [
        'http://localhost:3000',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:*',
        'http://localhost:*',
        'http://172.20.10.3:3000',
        'http://10.235.68.105:3000',
        'http://10.235.71.254:3000',
        'http://10.205.27.253:3000',
        '*'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
};

// 应用 CORS 中间件
app.use(cors(corsOptions));

// 添加预检请求的处理
app.options('*', cors(corsOptions));

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// 添加限流中间件
app.use(createRateLimiter({
    maxRequests: 100,  // 每分钟最多 100 次请求
    windowMs: 60000    // 1 分钟时间窗口
}));

// 路由
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes); 
app.use('/api/activities', activityRoutes);
app.use('/api/reminders', reminderRoutes);


// 测试路由
app.get('/hello', (req, res) => {
    const clientInfo = {
        ip: req.ip,
        originalUrl: req.originalUrl,
        protocol: req.protocol,
        hostname: req.hostname,
        headers: req.headers,
        connection: {
            remoteAddress: req.connection.remoteAddress,
            remotePort: req.connection.remotePort
        }
    };

    res.json({
        message: 'Hello World',
        timestamp: new Date().toISOString(),
        serverInfo: {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: process.uptime()
        },
        clientInfo
    });
});

// 基础健康检查接口
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date(),
        uptime: process.uptime()
    });
});

// 数据库连接和同步
async function initializeDatabase() {
    console.log('数据库名:', process.env.DB_NAME);
    try {
        await sequelize.authenticate();
        console.log('MySQL 连接成功');
        await sequelize.sync();
        console.log('数据库模型同步完成');
        return true;
    } catch (error) {
        console.error('数据库初始化失败:', error);
        if (process.env.NODE_ENV === 'production') {
            console.error('生产环境中数据库错误，应用将退出');
            process.exit(1);
        }
        return false;
    }
}

// 初始化定时任务
// scheduler.initializeJobs();

// 优雅关闭处理
// process.on('SIGTERM', () => {
//     logger.info('收到 SIGTERM 信号，准备关闭应用...');
//     scheduler.stopAllJobs();
//     process.exit(0);
// });

process.on('SIGINT', () => {
    logger.info('收到 SIGINT 信号，准备关闭应用...');
    scheduler.stopAllJobs();
    process.exit(0);
});

// 端口配置
const PORT = process.env.PORT || 3000;

// 错误处理中间件
app.use((err, req, res, next) => {
    logger.error('应用错误:', err);
    res.status(500).json({
        code: 500,
        message: '服务器内部错误',
        data: null
    });
});

// 全局异常处理
process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
    logger.error('未捕获的异常:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    logger.error('未处理的Promise拒绝:', reason);
    process.exit(1);
});

// 启动服务器（仅在直接运行时）
if (require.main === module) {
    console.log('开始启动服务器...');
    
    // 先初始化数据库，然后再启动服务器
    initializeDatabase().then((dbSuccess) => {
        console.log('数据库初始化结果:', dbSuccess);
        
        if (dbSuccess || process.env.NODE_ENV !== 'production') {
            console.log('开始启动HTTP服务器...');
            const server = app.listen(PORT, '0.0.0.0', () => {
                console.log(`服务器运行在端口 ${PORT}`);
                logger.info(`服务器启动成功，端口: ${PORT}`);
            });
            
            server.on('error', (error) => {
                console.error('服务器错误:', error);
                logger.error('服务器错误:', error);
            });
        } else {
            console.error('数据库连接失败，无法启动服务器');
            process.exit(1);
        }
    }).catch((error) => {
        console.error('启动失败:', error);
        logger.error('启动失败:', error);
        process.exit(1);
    });
}

module.exports = app;