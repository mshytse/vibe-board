# Team Activity Dashboard

Internal Jira activity feed and support board.

## Requirements

- **Node.js ≥ 14** — no `npm install` needed, all dependencies are built into Node.

## Setup

1. Run the server from the project folder:
   ```
   node server.js
   ```
2. Open **http://localhost:3000** in a browser.
3. Go to **http://localhost:3000/settings.html** and fill in:
   - **Jira URL** — your Atlassian instance URL
   - **Email** — your Scalr email
   - **API Token** — generate one at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
   - **Project Keys** — comma-separated keys for the projects you want to track
   - **Team Members** — search and add the people you want to monitor

## Docker (optional — for self-hosting on a server)

Build and push to Docker Hub:
```
docker build -t your-dockerhub-username/team-dashboard .
docker push your-dockerhub-username/team-dashboard
```

Run with a named volume so credentials survive restarts:
```
docker run -d \
  --name team-dashboard \
  --restart unless-stopped \
  -p 3000:3000 \
  -v team-dashboard-data:/data \
  your-dockerhub-username/team-dashboard
```

Then open `http://<server-ip>:3000/settings.html` to configure credentials.

## Notes

- Your credentials are stored locally in `config.json` (gitignored — never committed).
- Each person runs their own instance with their own API token.
