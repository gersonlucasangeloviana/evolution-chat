# Evolution Messages Viewer

App Node.js (Express) para visualizar histórico de mensagens (Instance → Chat → Message) direto do Postgres da Evolution API.

## Rodar local
```bash
npm install
export PORT=3000 ADMIN_USER=admin ADMIN_PASSWORD=senha
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=senha PGDATABASE=evolution PGSCHEMA=public
node server.js
```

## Docker
```bash
docker build -t evolution-messages-viewer .
docker run --rm -p 3000:3000   -e ADMIN_USER=admin -e ADMIN_PASSWORD=senha   -e PGHOST=postgres -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD=senha -e PGDATABASE=evolution -e PGSCHEMA=public   evolution-messages-viewer
```

Acesse: http://localhost:3000 (auth básica, se configurada)
Health: http://localhost:3000/health
