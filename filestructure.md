server/
├── node_modules/
├── src/
│   ├── api/                     # API routes and controllers (Express routers)
│   │   ├── articles.routes.js   # Routes for fetching/managing articles (e.g., GET /api/articles)
│   │   └── trigger.routes.js    # Routes to manually trigger jobs (e.g., POST /api/trigger/ingestion)
│   │
│   ├── config/                  # Configuration files
│   │   └── index.js             # Loads and exports environment variables
│   │
│   ├── jobs/                    # The core logic for our scheduled tasks
│   │   ├── ingestion.job.js     # Fetches, processes, and stores articles
│   │   └── posting.job.js       # Queries and posts articles to social media
│   │
│   ├── services/                # Modules for interacting with external APIs and DB
│   │   ├── supabase.service.js  # All communication with Supabase (using supabase-js)
│   │   ├── openai.service.js    # Logic for embeddings and summaries (using openai)
│   │   ├── facebook.service.js  # Logic for posting to Facebook Graph API
│   │   └── rss.service.js       # Logic for fetching and parsing RSS feeds (using rss-parser)
│   │
│   ├── utils/                   # Reusable helper functions (e.g., logging, error handling)
│   │   └── logger.js
│   │
│   ├── app.js                   # Initializes the Express app, sets up middleware (CORS, JSON), and mounts routes
│   └── server.js                # Starts the server and initializes the scheduler (node-cron)
│
├── .dockerignore                # Specifies files to ignore in the Docker build
├── .env                         # **Environment variables (local development - DO NOT COMMIT TO GIT)**
├── .env.example                 # Example variables for other devs (commit this)
├── Dockerfile                   # Defines the Docker container for deployment
└── package.json                 # Project dependencies and scripts (start, dev using nodemon)



client/
├── node_modules/
├── public/                      # Static assets (favicon, images)
├── src/
│   ├── assets/                  # Images, icons, etc.
│   ├── components/              # Reusable UI components
│   │   ├── ArticleCard/
│   │   │   ├── ArticleCard.jsx
│   │   │   └── ArticleCard.module.css # CSS Modules for styling
│   │   ├── layout/              # Layout components (Navbar, Sidebar, etc.)
│   │   └── common/              # Common components (Button, Spinner, Modal)
│   │
│   ├── context/                 # React Context for global state management
│   │   ├── ArticlesContext.jsx  # Manages state for articles, loading, errors
│   │   └── SettingsContext.jsx  # Manages state for app settings
│   │
│   ├── hooks/                   # Custom React hooks
│   │   └── useArticles.js       # Hook to interact with ArticlesContext
│   │
│   ├── pages/                   # Main application pages
│   │   ├── Dashboard.jsx
│   │   ├── Articles.jsx
│   │   └── Settings.jsx
│   │
│   ├── services/                # Functions for making API calls to our backend
│   │   └── api.js               # Configures Axios/Fetch and defines API functions
│   │
│   ├── App.jsx                  # Root component, sets up routing
│   └── main.jsx                 # Entry point of the React application
│
├── .env                         # **Environment variables (local development)**
├── .env.example                 # Example variables
└── package.json                 # Project dependencies and scripts (dev, build)