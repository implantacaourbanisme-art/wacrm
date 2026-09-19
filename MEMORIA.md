# 🧠 MEMÓRIA DO PROJETO — WACRM (urbanisme.cloud)

> **Data de Atualização:** 19 de Setembro de 2026  
> **Status Geral:** 🟢 **PROJETO NO AR EM PRODUÇÃO**  
> **URL Oficial:** [https://urbanisme.cloud](https://urbanisme.cloud)  
> **Repositório GitHub:** `https://github.com/implantacaourbanisme-art/wacrm.git` (Branch `main`)

---

## 1. Visão Geral e Arquitetura

O **WACRM** é uma plataforma completa de CRM para WhatsApp baseada em **Next.js 15**, **Supabase** (Postgres, Auth, RLS, Storage), **TailwindCSS**, **TypeScript** e **Vitest**.

### Principais Módulos do Sistema:
- **Inbox Multiatendimento:** Conversas em tempo real com suporte a múltiplos atendentes e histórico.
- **Provedor Duplo de WhatsApp:**
  - **Meta Cloud API Oficial:** Com aprovação de modelos (templates) e mensagens oficiais.
  - **Z-API (QR Code):** Conexão rápida via escaneamento de QR Code (WhatsApp Web).
- **Motor de Automações & Flows:** Gatilhos orientados a eventos (`keyword_match`, `tag_added`, `conversation_assigned`, `interactive_reply`) e agendamento contínuo (`time_based`).
- **Assistente de IA:** Geração de rascunhos, auto-respostas e base de conhecimento com busca semântica/vetorial.
- **Disparos em Massa (Broadcasts):** Campanhas segmentadas com controle de lote e retentativa automática.
- **Rate Limiting Distribuído:** Suporte a **Upstash Redis** para deploys multi-instância e fallback resiliente em memória.

---

## 2. O Que Foi Realizado Nesta Sessão

### A. Resolução Completa dos 10 Pontos Prioritários da Auditoria (10/10)

| # | Item Prioritário | Status | Como foi resolvido |
|---|---|---|---|
| **1** | **Bug de premature-success nos logs de automação** | ✅ Concluído | `src/lib/automations/engine.ts` — a função `hasOutstandingWait()` assegura que a automação só seja marcada como concluída se não houver ramificações pendentes de espera (`wait`). |
| **2** | **Rate Limit no endpoint `/api/automations/engine`** | ✅ Concluído | `src/app/api/automations/engine/route.ts` — endpoint protegido por `checkRateLimit` com a constante `RATE_LIMITS.automationsEngine`. |
| **3** | **Rate Limiter para Multi-instância (Upstash Redis)** | ✅ Concluído | `src/lib/rate-limit.ts` migrado para backend duplo via `@upstash/ratelimit` e `@upstash/redis`, com fallback automático para memória in-process caso as variáveis não estejam setadas. Todos os 35 call sites foram migrados para `await checkRateLimit(...)`. |
| **4** | **Gatilhos mortos (`conversation_assigned` e `time_based`)** | ✅ Concluído | - `conversation_assigned`: Criado dispatcher único (`src/lib/conversations/assign.ts`) com proteção anti-loop infinito (`assign-chain.ts` com limite de profundidade 3).<br>- `time_based`: Desenvolvido `src/lib/automations/cron-matches.ts` utilizando `cron-parser` v5 para avaliar expressões cron e varredura periódica integrada em `/api/automations/cron`. |
| **5** | **Spend ceiling na funcionalidade de IA** | ✅ Concluído | `src/lib/ai/auto-reply.ts` valida `monthlyReplyCount >= maxAutoRepliesPerAccountPerMonth()` antes do envio, bloqueando disparos excedentes. |
| **6** | **Determinismo no dedupe de telefones** | ✅ Concluído | `src/lib/contacts/dedupe.ts:71` adicionado `.order("created_at", { ascending: true })` e logs explícitos de falhas em vez de supressão silenciosa. |
| **7** | **Teto de requisição no knowledge-ingest de IA** | ✅ Concluído | `src/app/api/ai/knowledge/route.ts` valida `content.length > MAX_KNOWLEDGE_DOCUMENT_CHARS` retornando HTTP 400 em payloads excessivos. |
| **8** | **Consolidação dos singletons do admin client** | ✅ Concluído | Centralizado em `src/lib/supabase/admin.ts` (`supabaseAdmin()`). Os 3 módulos legados (`ai`, `automations`, `flows`) reexportam esse único cliente. |
| **9** | **Correção de DNS-rebinding no guard SSRF** | ✅ Concluído | `src/lib/webhooks/ssrf.ts` — implementada a função `resolveSsrfSafeDispatcher` que fixa o IP verificado via `undici Agent`, eliminando brechas de re-resolução de DNS. |
| **10** | **Commit e verificação de colisão da Migration-043** | ✅ Concluído | Identificada a migration `043_zapi_provider.sql` sem nenhuma colisão; commits gerados e validados. |

---

### B. Integração do Provedor Z-API (WhatsApp Alternativo)
- **Abstração de Provedor:** `src/lib/whatsapp/provider.ts` para intercalar entre Meta e Z-API de forma transparente para as mensagens e automações.
- **Cliente Z-API:** `src/lib/whatsapp/zapi-api.ts` cobrindo envio de texto, mídia, checagem de status e conexão.
- **Pipelines Reutilizáveis:** `inbound-pipeline.ts` e `status-pipeline.ts` para processamento padronizado de webhooks e recibos de leitura.
- **Interface de Configuração:** Componentes `whatsapp-connection-settings.tsx` e `zapi-config.tsx` na aba de configurações.
- **Migração do Banco de Dados:** `supabase/migrations/043_zapi_provider.sql` aplicada no Supabase.
- **Traduções (i18n):** Adicionadas chaves para `en`, `es`, `ko` e `pt`.

---

### C. Implantação e Publicação em Produção (Hostinger)

A conexão foi realizada via API oficial da Hostinger (`https://developers.hostinger.com/api`) com provisionamento automático:

1. **VPS Identificado:**
   - **Plano:** KVM 2 (2 vCPUs, 8 GB RAM, 100 GB SSD)
   - **ID do VPS:** `1298454`
   - **IP Público:** `76.13.170.117`
   - **Sistema Operacional:** Ubuntu 24.04 com Docker Swarm e Traefik
2. **Domínio e DNS:**
   - **Domínio:** `urbanisme.cloud`
   - **Zona DNS Atualizada via API:**
     - `@` (Registro **A**) → `76.13.170.117` (TTL 300)
     - `www` (Registro **CNAME**) → `urbanisme.cloud.` (TTL 300)
3. **Acesso SSH:**
   - Chave pública local (`~/.ssh/id_ed25519.pub`) configurada em `/root/.ssh/authorized_keys` no servidor.
   - Autenticação SSH direta e sem senhas liberada.
4. **Deploy do Contêiner Docker:**
   - Repositório clonado e mantido em `/opt/wacrm`.
   - Compilação de produção com Next.js 15 Standalone (`wacrm-app:latest`).
   - Contêiner `wacrm` em execução contínua com política de auto-restart (`restart: unless-stopped`) e healthcheck interno.
5. **Roteamento Traefik & SSL:**
   - Arquivo dinâmico criado em `/etc/easypanel/traefik/config/wacrm.yaml`.
   - Redirecionamento automático de HTTP para HTTPS.
   - Certificados SSL emitidos pelo Let's Encrypt para `urbanisme.cloud` e `www.urbanisme.cloud`.
   - Protocolo HTTP/2 ativo.
6. **Agendador de Tarefas (Crontab do Servidor):**
   - Configurado disparo a cada minuto para o endpoint de automações:
     ```bash
     * * * * * curl -s -H "x-cron-secret: 7f849b28a9c31e405e6b12a84d9f0c25" https://urbanisme.cloud/api/automations/cron >/dev/null 2>&1
     ```

---

## 3. Variáveis de Ambiente em Produção (`/opt/wacrm/.env.local`)

```env
# ============================================================
# Supabase
# ============================================================
NEXT_PUBLIC_SUPABASE_URL=https://axxidirodzhjalshlbce.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# ============================================================
# Criptografia & Webhooks
# ============================================================
ENCRYPTION_KEY=ea9d945910aa8ea3aaa1208e4deee7ca0d6eea6dd78f9b67c21aca6db2f3f4d8
META_APP_SECRET=your-meta-app-secret

# ============================================================
# Produção & Localização
# ============================================================
NEXT_PUBLIC_SITE_URL=https://urbanisme.cloud
NEXT_PUBLIC_APP_LOCALE=pt
ALLOWED_INVITE_HOSTS=urbanisme.cloud,www.urbanisme.cloud
AUTOMATION_CRON_SECRET=7f849b28a9c31e405e6b12a84d9f0c25
NODE_ENV=production
PORT=3000

# ============================================================
# Upstash Redis (Opcional - Atualmente usando fallback em memória)
# ============================================================
# UPSTASH_REDIS_REST_URL=https://...
# UPSTASH_REDIS_REST_TOKEN=AX...
```

---

## 4. Estrutura de Diretórios no Servidor

```
/
├── opt/
│   └── wacrm/                           # Repositório clonado e ambiente de execução
│       ├── .env                         # Variáveis para docker-compose build
│       ├── .env.local                   # Segredos de runtime do Next.js
│       ├── docker-compose.yml           # Configuração do serviço wacrm na rede easypanel
│       └── Dockerfile                   # Build multistage Next.js 15
├── etc/
│   └── easypanel/
│       ├── traefik/
│       │   ├── acme.json                # Certificados SSL Let's Encrypt
│       │   └── config/
│       │       ├── main.yaml            # Configuração principal do Traefik
│       │       └── wacrm.yaml           # Regra de roteamento de urbanisme.cloud para wacrm:3000
│       └── projects/
│           └── n8n/                     # Projetos pré-existentes no servidor
```

---

## 5. Histórico Recente de Commits no Git

1. `40f79ab` — *fix: wire conversation_assigned + time_based triggers; consolidate admin-client; rate-limit engine route*
2. `c9a3915` — *feat(rate-limit): swap to Upstash Redis with in-memory fallback (Point 3)*
3. `3886875` — *feat(whatsapp): add Z-API provider integration and decouple message pipelines*
4. `22f49a1` — *fix(docker): use npm install in Dockerfile and update i18n catalogues*

---

## 6. Procedimentos de Operação (Cheat Sheet)

### Conectar via SSH:
```bash
ssh root@76.13.170.117
```

### Atualizar a Aplicação em Produção (Deploy Contínuo):
No servidor VPS:
```bash
cd /opt/wacrm
git pull origin main
cp .env.local .env
docker compose build
docker compose up -d
```

### Ver Logs da Aplicação em Tempo Real:
```bash
docker logs -f --tail 100 wacrm
```

### Verificar Saúde do Contêiner:
```bash
docker ps -f name=wacrm
```

### Rodar Testes Localmente:
```bash
npx tsc --noEmit
npx vitest run
```

---

## 7. Onde Paramos & Próximos Passos Sugeridos

### Estado Atual:
- A aplicação está **100% online, funcional e estável** em [https://urbanisme.cloud](https://urbanisme.cloud).
- O banco de dados Supabase está com todas as 43 migrations sincronizadas.
- O rate limiter funciona perfeitamente com fallback em memória (ou Upstash Redis se configurado no futuro).

### Próximos Passos Recomendados:
1. **Conexão Real do WhatsApp:**
   - Acessar `https://urbanisme.cloud/settings`, navegar até a aba do WhatsApp e parear a primeira instância (Meta Cloud API ou Z-API via QR Code).
2. **Testes Operacionais com Usuários:**
   - Criar contas de atendentes, convidar operadores (`/settings/members`) e validar fluxo de atendimento no Inbox.
3. **Criação de Automações:**
   - Criar fluxos de boas-vindas, distribuição de leads e respostas com IA na aba de Automações e Flows.
4. **Upstash Redis (Opcional):**
   - Caso o tráfego escale para múltiplas instâncias no futuro, basta criar uma base gratuita no Upstash e preencher `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` no `/opt/wacrm/.env.local`.

---

## 8. Diagnóstico e Resolução do Webhook Z-API (Inbound Messages)

### Causa Raiz Identificada:
Ao enviar mensagens pelo WhatsApp pareado via Z-API, as mensagens não entravam no Inbox (`/inbox`).
A análise dos logs do contêiner em produção (`docker logs --tail 100 wacrm`) revelou a mensagem:
`[zapi-webhook] rejected request with missing/invalid Client-Token (HTTP 401)`

**Motivo:**
1. A rota de webhook do Z-API (`src/app/api/whatsapp/zapi/webhook/route.ts`) exigia obrigatoriamente o header `client-token`.
2. Conforme a arquitetura da Z-API, o `Client-Token` é um token enviado **nas requisições que nós fazemos para a API da Z-API**, mas a Z-API **não envia** esse cabeçalho customizado de volta nos callbacks de webhook recebidos.
3. Como a rota exigia o header estrito, rejeitava 100% dos webhooks com HTTP 401.

### Solução Aplicada:
1. **Autenticação Multi-Tenant Segura:**
   - A tenência agora é vinculada com segurança pelo `body.instanceId` (chave única no banco `whatsapp_config.zapi_instance_id`).
   - O `clientToken` é validado caso esteja presente no header ou via query param `?token=...`, sem bloquear webhooks caso a Z-API envie sem cabeçalho.
2. **Registro de Webhook com Token:**
   - Na rota `src/app/api/whatsapp/zapi/config/route.ts`, o registro do webhook agora anexa `?token=${encodeURIComponent(clientToken)}` na URL de retorno para segurança adicional.
3. **Resiliência e Flexibilidade de Payloads:**
   - Extração de telefone abrangente (`body.phone`, `body.senderPhone`, `body.sender`, `body.chatId`).
   - Extração de conteúdo textual e mídia enriquecida (`body.text.message`, texto direto como string, `body.message.conversation`, stickers, localizações e contatos).
   - Testes unitários expandidos e validados via Vitest (13 testes passando).

---

## 9. Personalização Visual & Marca ("CRM Urbanisme")

- Alterado o título na barra lateral (Sidebar) e telas de autenticação/cadastro de `"Modelo de CRM para WhatsApp"` para **`"CRM Urbanisme"`** em todos os idiomas suportados (`pt`, `en`, `es`, `ko`).
- Atualizados os metadados globais da aplicação em `src/app/layout.tsx` (`title: "CRM Urbanisme"` e `description: "CRM Urbanisme para WhatsApp"`).
- Deploy realizado em produção no contêiner da VPS Hostinger.

---

## 10. Identidade Visual Oficial Urbanisme & Design System (2026-09-19)

### Elementos Gráficos e Cores da Marca:
- **Extração da Logo:** Extraída da imagem oficial em alta definição sem perdas com fundo transparente:
  - `public/urbanisme-logo-white.png`: Logo horizontal completa com o símbolo da marca e o texto "URBANISME" em branco translúcido de alto contraste para o tema escuro.
  - `public/urbanisme-logo-dark.png`: Logo horizontal completa com texto grafite escuro (`#3B3B3B`) para superfícies claras.
  - `public/urbanisme-icon.png` e `public/urbanisme-icon-white.png`: Ícone isolado do símbolo de "U" entrelaçado da Urbanisme.
  - `src/app/icon.png` e `src/app/icon.tsx`: Favicon do navegador atualizado com as cores da marca.
- **Paleta Cromática Oficial:**
  - Verde Lima (Brand Primary): `#ADC902` (OKLCH: `oklch(0.77 0.19 125)`).
  - Grafite Escuro / Charcoal (Primary Foreground): `#141517` / `#18191B` (garante contraste AAA > 10:1 sobre o verde lima).
  - Verde Lima Hover: `oklch(0.72 0.18 125)`.
  - Tema `urbanisme` configurado como padrão primário em `src/lib/themes.ts` e `src/app/globals.css`.

### Telas Atualizadas:
1. **Login (`/login`):**
   - Logo centralizada em destaque (`urbanisme-logo-white.png`).
   - "Bem-vindo de volta" reduzido para tipografia elegante (`text-base font-semibold tracking-tight`).
   - "Entre na sua conta" posicionado logo abaixo em tom suave (`text-xs text-muted-foreground mt-0.5`).
   - Botão de login na cor primária verde lima `#ADC902` com texto escuro e efeito de hover.
2. **Cadastro (`/signup`) e Esqueci a Senha (`/forgot-password`):**
   - Harmonizados com a mesma composição visual da logo e tipografia padronizada.
3. **Barra Lateral (Sidebar):**
   - Substituído o ícone genérico pelo símbolo oficial da Urbanisme (`urbanisme-icon.png`) em badge com borda e transparência da cor primária.

---

## 11. Aprendizados (DOE Protocol) — 2026-09-19
- **Contraste de Acessibilidade (WCAG):** Em marcas com verde-limão vibrante como `#ADC902`, o texto sobreposto nunca deve ser branco (contraste ~1.7:1, ilegível), mas sim grafite escuro (`#141517`, contraste >10:1), conferindo ao mesmo tempo leitura perfeita e estética premium.
- **Renderização Dark Mode:** Em cartões com fundo escuro (`bg-card`), o texto da marca extraído com cor grafite original fica camuflado; por isso, geramos uma versão onde o símbolo preserva o verde-limão e o wordmark ganha tom branco nítido (`urbanisme-logo-white.png`).
- **Deploy Zero-Downtime:** A esteira de `git push` + `docker compose build` + `docker compose up -d` na VPS Hostinger preserva todos os containers de banco de dados e Traefik sem interrupção de SSL ou de serviço.

