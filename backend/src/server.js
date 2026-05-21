import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import questionRoutes from './routes/question.routes.js';
import learningPackRoutes from './routes/learningPack.routes.js';
import subjectRoutes from './routes/subject.routes.js';
import contentRoutes from './routes/content.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import geminiErrorRoutes from './routes/geminiErrors.routes.js';
import contentManagementRoute from './routes/contentManagement.routes.js'
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration for frontend domains
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://braincoins.vercel.app',
    'https://braincoinsadmin.vercel.app'
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));


// === FIX FOR 413 ERROR: INCREASE BODY LIMITS TO 100MB ===
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
// CRITICAL ADDITION: This is essential for large file data
app.use(express.raw({ limit: '100mb' }));
// =======================================================


// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Brain Coins Backend API is running',
        timestamp: new Date().toISOString()
    });
});

// API Routes
app.use('/api/questions', questionRoutes);
app.use('/api/learning-packs', learningPackRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/gemini-errors', geminiErrorRoutes);
app.use('/api/content-management', contentManagementRoute);
// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('[Backend] Error:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error'
    });
});
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`[Backend] Server running on port ${PORT}`);
    });
}


export default app;