const fs = require('fs');
const path = require('path');

// Directories to create (ensures empty folders are created too)
const dirs = [
    'server/src/api',
    'server/src/config',
    'server/src/jobs',
    'server/src/services',
    'server/src/utils',
    'client/public',
    'client/src/assets',
    'client/src/components/ArticleCard',
    'client/src/components/layout',
    'client/src/components/common',
    'client/src/context',
    'client/src/hooks',
    'client/src/pages',
    'client/src/services'
];

// Files to create
const files = [
    'server/src/api/articles.routes.js',
    'server/src/api/trigger.routes.js',
    'server/src/config/index.js',
    'server/src/jobs/ingestion.job.js',
    'server/src/jobs/posting.job.js',
    'server/src/services/supabase.service.js',
    'server/src/services/openai.service.js',
    'server/src/services/facebook.service.js',
    'server/src/services/rss.service.js',
    'server/src/utils/logger.js',
    'server/src/app.js',
    'server/src/server.js',
    'server/.dockerignore',
    'server/.env',
    'server/.env.example',
    'server/Dockerfile',
    'server/package.json',
    'client/src/components/ArticleCard/ArticleCard.jsx',
    'client/src/components/ArticleCard/ArticleCard.module.css',
    'client/src/context/ArticlesContext.jsx',
    'client/src/context/SettingsContext.jsx',
    'client/src/hooks/useArticles.js',
    'client/src/pages/Dashboard.jsx',
    'client/src/pages/Articles.jsx',
    'client/src/pages/Settings.jsx',
    'client/src/services/api.js',
    'client/src/App.jsx',
    'client/src/main.jsx',
    'client/.env',
    'client/.env.example',
    'client/package.json'
];

// Create Directories
dirs.forEach(dir => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

// Create Files
files.forEach(file => {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, `// ${path.basename(file)}`);
        console.log(`Created file: ${file}`);
    }
});

console.log('Folder structure created successfully.');