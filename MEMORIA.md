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


---

## 12. Integração Bot n8n ↔ WACRM (2026-09-20)

**Arquitetura (uma só instância Z-API `3EF092…`, compartilhada pelo bot e pelo WACRM):**
- O **n8n é o único receptor** do webhook de mensagens recebidas da Z-API (`/webhook/urbanisme`). A Z-API guarda **uma URL por evento**: nunca parear o WACRM sem marcar **"Não registrar webhook (modo espelho)"** em Configurações > WhatsApp > Z-API, senão o webhook do bot é sobrescrito e o bot para (aconteceu em 19/09 às ~19h UTC e foi corrigido em 20/09).
- Estado dos callbacks na Z-API: `received` → n8n (com `receiveCallbackSentByMe` ligado); `delivery` e `presence` limpos; `status/connected/disconnected` → WACRM. Conferir com `GET /instances/<id>/token/<token>/me` (Client-Token no header).
- **Cópias de arquivos locais de workflows (`Workflows/*.json`) estão desatualizadas** (mostram a instância antiga `3F0FF…`); sempre ler o workflow vivo pela API do n8n.

**A. Espelho do bot no Inbox:** nó `Espelhar no WACRM` no workflow `Urbanisme` (`ZfvZh0GieQujFa19PQXjq`), em paralelo ao `Webhook`, envia a cópia do payload para `https://urbanisme.cloud/api/whatsapp/zapi/webhook?mirror=1` com o header `client-token` (credencial n8n `WACRM Mirror (client-token)`). Modo espelho no WACRM: só grava contato/conversa/mensagem, sem Flows/Automações/IA/webhooks; `fromMe` vira mensagem `bot`. O `Filtro Inicial1` do bot descarta ecos `fromApi`. O WACRM mostra menus de lista/botões do bot como texto (`formatListMessage`).

**B. Transbordo → WACRM e silêncio do bot:**
- `POST /api/v1/handoffs` (escopo `conversations:write`): acha/cria contato+conversa, atribui ao membro pelo e-mail (Alisson, `joalyssoncleverton96@icloud.com`, papel agent), reabre e grava o resumo como nota. Nó `Criar caso no WACRM` no workflow `Transbordo` (`gx1ZB1uffIFcyCPs`), em paralelo; o **relatório por WhatsApp permanece** (decisão do usuário).
- Evento de webhook `message.sent` (só quando um humano envia pelo Inbox) → workflow n8n `WACRM | Atendente respondeu` (`WKwnVZ5Zsck8B4C8`, caminho aleatório longo) → Redis `{telefone}_status = Desativado` TTL 900 s (mesma chave do Transbordo). Validado ponta a ponta com `558296004382`.

**C. Sincronização de Leads:** `POST /api/v1/contacts/sync` (escopo `contacts:write`, até 100 por chamada, idempotente). CPF/CNPJ vai para o campo personalizado `CPF/CNPJ` (dígitos), exibido no sidebar do Inbox mascarado com olho e copiar. Workflow `Leads → WACRM (sync)` (`Bw3tVWUkE3ktytgL`): a cada 10 min + gatilho manual "Sincronizar agora"; agrupa Leads pelos **últimos 8 dígitos** do telefone (mesmo critério do WACRM) e envia só o de interação mais recente.

**Chaves de API do WACRM:** "API-Handoff" (`conversations:write`), "API-Leads" (`contacts:write`); a "API-Webhooks" (`webhooks:manage`) foi temporária e deve ser revogada. Chaves só aparecem uma vez; revogar a antiga invalida a credencial n8n `WACRM API (Bearer)` (obsoleta, pode ser apagada).

**Pendências / acompanhamentos:**
- Máscara do CPF só no sidebar; a tela de detalhe do contato e as variáveis de disparo em massa mostram o valor em texto.
- `send-carousel` do bot ainda aparece como "não suportado" no Inbox (formato do payload não mapeado).
- Não há índice UNIQUE em `custom_fields (account_id, field_name)`; mitigado no código (só `CPF/CNPJ` é criado sob demanda).
- Deploy do WACRM: SSH ao VPS está sem a chave do usuário (`Permission denied`); deploy feito pelo Web console da Hostinger: `cd /opt/wacrm && git pull origin main && cp .env.local .env && docker compose build && docker compose up -d`.
- Falhas de teste pré-existentes e não relacionadas: `src/lib/currency.test.ts` e `src/lib/dashboard/date-utils.test.ts` (dependem do locale).
- Specs e planos: `docs/superpowers/specs/` e `docs/superpowers/plans/` (2026-09-20-*).

### 12.1 Funis por setor, negócio automático e correções do bot (2026-09-20/21)
- **Pipelines do WACRM (contas de teste = Urbanisme):** `Vendas` (Contato inicial → Visita agendada → Proposta → Negociação → Contrato; padrão = o mais antigo), `Financeiro` (Solicitação recebida → Em análise → Aguardando cliente → Resolvido) e `Jurídico` (Recebido → Em análise → Parecer → Concluído). A **última etapa conta como "ganho" por posição** (não pelo nome). O modelo de novos pipelines no código também está em português.
- **`POST /api/v1/handoffs` ganhou `create_deal`, `deal_title`, `deal_pipeline`:** abre negócio na 1ª etapa do funil escolhido pelo NOME (sem fallback: nome inexistente => sem negócio), moeda da conta, valor 0, status `open` (o CHECK só aceita open/won/lost), `assigned_to` = `profiles.id`; reaproveita negócio aberto do contato no mesmo funil.
- **Regra do Transbordo (nó `Criar caso no WACRM`):** o setor vem do ÚLTIMO menu no histórico do relatório (`Acessou o Menu Comercial|Financeiro` ou linha `Jurídico`) ou de "corretor" na mensagem. Comercial → Vendas; Financeiro → funil Financeiro (`Financeiro — Nome`); Jurídico → funil Jurídico; sem menu => sem negócio.
- **Bug do Transbordo corrigido:** o `Merge` sobrescrevia `id`/`created_at` das linhas de `n8n_chat_histories` com os do Lead, então "as últimas 20 mensagens" eram aleatórias/antigas (relatório desatualizado e setor errado). O nó `Code in JavaScript` agora lê `$('Get many rows')` e `$('Buscar lead')` diretamente.
- **Loop do Boleto corrigido:** `Aguardando Boleto?` exigia também CPF/e-mail na mensagem (sobra do fluxo antigo); com cadastro completo a resposta caía na IA e ela repetia "qual o assunto". A condição extra foi removida (igual a Demonstrativo/Jurídico).
- **Trava anti-loop no Financeiro:** depois que o ramo "Falar com atendente" (fallback do `Switch1`) pergunta o assunto, o nó `Aguardar assunto (trava anti-loop)` grava `{tel}_aguardando_boleto` (TTL 300 s) e a próxima resposta vai direto ao Transbordo. Só marca quando `É pedido de atendente?` (não é saudação nem mensagem curta), para que um desvio da IA com "oi" não gere transferência indevida.
- **Risco conhecido:** a IA (`AI Agent1`) pode rotear "oi" para a ferramenta errada (`enviar_menu_financeiro`) quando o histórico de chat do número está poluído; a saudação determinística ainda não foi implementada.
- **Limpar o silêncio do bot de um número de teste:** workflow temporário com Webhook → Redis DELETE com a chave FIXA `558296004382_status`, executado e removido (nunca aceitar chave vinda de fora).
- Backups dos workflows editados ficam no scratchpad da sessão; a cópia local `Workflows/*.json` continua desatualizada.

---

## 13. Integração Google Calendar & Painel de Agenda no Dashboard (2026-09-30)

### 1. Atualização dos Nós no n8n (Agendamento IA)
- **Workflow:** `Urbanisme | Sub | Agendamento IA` (`QQ8lBCcB9hG4VE1K`).
- **Nós Atualizados:** `buscar_eventos`, `criar_evento` e `deletar_evento`.
- **Alteração Realizada:** O identificador da agenda foi atualizado de `altodasarapiracas@gmail.com` para **`implantacaourbanisme@gmail.com`** tanto na tabela `workflow_entity` quanto na `workflow_history` do SQLite interno do n8n.
- **Credencial Ativa:** `v1b9CoCqG4DzmAnM` ("Urbanisme", tipo `googleCalendarOAuth2Api`), conectada e autenticada com sucesso pelo usuário via OAuth2.
- **Validação:** Token renovado via `oauth2.googleapis.com` com status HTTP 200 OK e listagem de eventos operando normalmente.

### 2. Novo Módulo e Painel de Agenda no WACRM
- **Serviço de Integração (`src/lib/calendar/google-calendar.ts`):**
  - Autenticação server-side com Google OAuth2 utilizando `GOOGLE_CALENDAR_REFRESH_TOKEN`, `CLIENT_ID` e `CLIENT_SECRET`.
  - Cache em memória do token de acesso para evitar requisições redundantes de refresh.
  - Normalizador inteligente de eventos: extrai Nome do Cliente, Loteamento/Serviço e Telefone (a partir de títulos como `Visita Jatobá — Nome` ou metadados na descrição).
  - Agrupamento temporal (`groupEventsByDay`) formatando cabeçalhos no padrão exato solicitado (`HOJE · X HORÁRIOS`, `QUARTA-FEIRA · 19/08/2026 · X HORÁRIOS`).
- **Rota de API (`src/app/api/calendar/events/route.ts`):**
  - `GET`: Retorna eventos e grupos ordenados cronologicamente, com suporte a filtros de período (`startDate`, `endDate`).
  - `POST`: Criação rápida de novos agendamentos na agenda oficial diretamente pelo CRM.
- **Página de Agenda (`src/app/(dashboard)/agenda/page.tsx`):**
  - Visual idêntico ao modelo de referência da clínica/imobiliária:
    - Badge verde-lima com horário de início em destaque e término logo abaixo.
    - Bloco com nome do cliente em negrito, serviço/loteamento e telefone.
    - Ações rápidas no modal de detalhes: botão para abrir a conversa no Inbox (`/inbox?phone=...`) ou no WhatsApp Web.
    - Filtros por período (Hoje, Próximos 7 dias, Próximos 30 dias).
    - Botão "Sincronizar" com feedback visual de carregamento.
    - Modal de "Novo Agendamento" para criação rápida direto pelo CRM.
    - Link direto para abrir a agenda no Google Agenda web.
- **Navegação & i18n:**
  - Item "Agenda" inserido na barra lateral (`sidebar.tsx`) com ícone `Calendar`.
  - Traduções adicionadas nos catálogos `pt.json`, `en.json`, `es.json` e `ko.json`.
- **Deploy em Produção:**
  - Código compilado sem erros no TypeScript (`tsc --noEmit`) e validado por testes unitários (`google-calendar.test.ts`).
  - Commit e push realizados para `origin/main`.
  - Imagem Docker reconstruída e container `wacrm` reiniciado em produção na VPS Hostinger com status `healthy`.
  - Rota `https://urbanisme.cloud/agenda` ativa e respondendo HTTP/2 200.

---

## 14. Aprendizados (DOE Protocol) — 2026-09-30
- **Ciclo de Vida do OAuth do Google:** Em projetos do Google Cloud em modo de "Teste", o `refresh_token` expira compulsoriamente a cada 7 dias. Para conexões corporativas duradouras, o projeto deve ser alternado para "Em produção" na tela de consentimento OAuth do Google Console.
- **Persistência de Workflows no n8n v2:** Ao atualizar nós diretamente na base de dados do n8n, é essencial atualizar tanto a tabela `workflow_entity` quanto a `workflow_history`, pois o motor do n8n e o comando de exportação utilizam a versão registrada no histórico para montagem dos nós.
- **Resiliência no Next.js App Router:** No Next.js 16 com Turbopack, chamadas a APIs externas com dados em tempo real devem especificar explicitamente `cache: "no-store"` para evitar que agendamentos criados externamente sejam ocultados pelo cache de rotas.

---

## 15. Dinâmica de Agendamento no WhatsApp (n8n) & Capacidades do Agente (2026-10-01)

### 1. Inclusão de "Agendamento" no Menu Inicial e Reenvio
- **Workflow `Boas Vindas` (`bbQHAdvY9bGFLzbGmVIFn`):**
  - Adicionada a opção `Agendamento` com a descrição `"Agendar, consultar ou desmarcar visita"`.
  - O menu principal via WhatsApp agora apresenta 4 opções claras e objetivas:
    1. `Comercial`
    2. `Agendamento`
    3. `Financeiro`
    4. `Jurídico`
- **Workflow Principal `Urbanisme` (`ZfvZh0GieQujFa19PQXjq`):**
  - Atualizados os nós `Z-API Reenviar Menu Inicial` e `Z-API Reenviar Menu Inicial1` com as mesmas 4 opções sincronizadas.

### 2. Roteamento Determinístico e Sessão de Agendamento
- **Nó `If2`:**
  - Atualizado para interceptar `Agendamento`, `agendamento`, `Agendar` e `Agendar Visita`, direcionando sem latência para o `Switch`.
- **Nó `Switch`:**
  - Regra 3 (`Agendar com Corretor`) atualizada com a condição:
    `{{ ['Agendar Visita', 'Agendamento', 'agendamento', 'Agendar'].includes(($json.message || '').trim()) }}`
  - Aciona diretamente o sub-workflow `Urbanisme | Sub | Agendamento IA` (`QQ8lBCcB9hG4VE1K`), ativando a flag `aguardando_agendamento:{telefone}` (TTL 300s) no Redis para manter a sessão do cliente até a finalização do atendimento.

### 3. Agente Inteligente Dama & Ferramentas Google Calendar
- **Identidade da Marca:** Atualizado para "Urbanisme Empreendimentos" com catálogo de loteamentos oficiais (Jatobá, Flor de Maria, Alto das Arapiracas, Flor do Ipê, Alto do Morro).
- **Cobertura Completa das 4 Intenções do Usuário:**
  1. **Disponibilidade e Novo Agendamento:**
     - Agente pergunta o loteamento e o horário desejado.
     - Consulta eventos existentes com a ferramenta `buscar_eventos` na API do Google Calendar.
     - Propõe opções e só cria o evento com `criar_evento` após o aceite do cliente.
     - Finaliza com marcador estruturado: `[[CONFIRMADO]][[DADOS:{"loteamento":"...","data_hora":"..."}]]`.
  2. **Desmarcar / Cancelar Visita:**
     - Agente consulta a agenda com `buscar_eventos` pelo telefone/nome do cliente.
     - Localiza o ID do evento, pede confirmação e invoca `deletar_evento`.
     - Confirma com o cliente e finaliza com `[[ENCERRADO]]`.
  3. **Remarcação de Visita:**
     - Localiza o agendamento atual com `buscar_eventos`.
     - Checa a nova data/horário com `buscar_eventos`.
     - Exclui o antigo (`deletar_evento`) e cadastra o novo (`criar_evento`).
     - Finaliza com `[[CONFIRMADO]][[DADOS:...]]`.
  4. **Notificação e Localização:**
     - Ao confirmar, o sub-workflow envia as coordenadas do escritório/estande via WhatsApp (`send-location`).
     - Corrigido o `Client-Token` em `Z-API Enviar Localização` para o token oficial (`F1e7350a95c864b6aa27acc32f32c73f6S`), eliminando risco de rejeição 401.
     - O agendamento é registrado no banco `agendamentos` e aparece imediatamente no painel de Agenda do CRM.

---

## 16. Aprendizados (DOE Protocol) — 2026-10-01
- **Roteamento Híbrido Determinístico + Semântico:** Em bots de WhatsApp com menus de botões e listas, escolhas estruturadas devem ser roteadas deterministicamente por nós `If` e `Switch` antes de chegarem ao agente de IA, garantindo tempo de resposta sub-segundo e eliminando alucinações de roteamento.
- **Sessões Conversacionais Efêmeras no Redis:** A utilização de flags de sessão com TTL (ex: `aguardando_agendamento:{telefone}` com 300 segundos e renovação automática) garante que o cliente converse continuamente com o agente especializado sem a necessidade de repetir o menu a cada frase.
- **Piping em Scripts SSH Remotos:** Ao atualizar estruturas complexas com JSON e templates no n8n via SSH, utilizar `stream.write` em vez de passar argumentos inline no bash evita problemas de escape com caracteres especiais (`$`, backticks, aspas duplas e quebras de linha).

---

## 17. Correção Crítica no Agente Dama (Sub-Workflow de Agendamento) — 2026-10-01

### 1. Diagnóstico do Problema ("cliquei em agendamento e não aconteceu nada")
- **Execuções Analisadas no n8n:** Execução 2114 (`Urbanisme` - Main) e Execução 2115 (`Urbanisme | Sub | Agendamento IA`).
- **Comportamento do Roteamento:** O roteamento determinístico funcionou perfeitamente: Webhook -> Lead -> Buffer -> If2 -> Switch (Regra 3) -> Sub-workflow de Agendamento.
- **Causa Raiz da Falha:**
  - O nó de modelo `@n8n/n8n-nodes-langchain.lmChatOpenAi` ("OpenAI gpt-4o-mini") no sub-workflow `QQ8lBCcB9hG4VE1K` não possuía o parâmetro `model` configurado explicitamente no JSON de parâmetros, mantendo apenas `options.temperature: 0.3`.
  - No n8n v2.42, nós LangChain sem seleção explícita de modelo adotam dinamicamente a primeira opção da lista alfabética retornada pela API da OpenAI (família de raciocínio `o1` / `o1-mini`).
  - Como a família `o1` não aceita alteração de temperatura (apenas o padrão 1), a chamada para a API da OpenAI rejeitou a requisição com o erro HTTP `400 Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported`.
  - Este erro 400 abortou a execução do `Agente Dama` antes de qualquer envio de mensagem para o WhatsApp via Z-API.

### 2. Ação Corretiva Aplicada
- **Workflow de Agendamento (`QQ8lBCcB9hG4VE1K`):**
  - O nó de modelo foi atualizado para `typeVersion: 1.3`, com modelo explícito `gpt-4o` (`cachedResultName: "gpt-4o"`), credencial `jN8b5gyKK7r2CMmS` e temperatura `0.2`.
- **Prevenção no Workflow Financeiro (`97pEDuouJdDKgJRv`):**
  - O mesmo nó no sub-workflow de Financeiro também não possuía modelo explícito. Foi atualizado preventivamente para `gpt-4o` com `typeVersion: 1.3` e temperatura `0.2`.
- **Limpeza de Containers & Atualização Swarm:**
  - O container zumbi legado `a43eb73523a0` (`n8n:2.39.2`) foi removido.
  - O serviço oficial Docker Swarm (`n8n_n8n`) foi reiniciado via `docker service update --force n8n_n8n`.
  - O novo container ativo (`f8b546c35d0b`) validou a carga dos novos nós em tempo real com status operacional e sem erros.

---

## 18. Aprendizados e Protocolos Operacionais (DOE Protocol) — 2026-10-03

- **Resolução de Modelos em Nós LangChain no n8n v2:** Nós de modelo LLM (`lmChatOpenAi`) no n8n nunca devem ser deixados sem a propriedade `model` explicitamente parametrizada. O n8n v2 ordena os modelos alfabeticamente pela API do provedor e, na ausência de seleção explícita, adota a primeira opção da lista (`o1` / `o1-mini` da OpenAI), gerando incompatibilidade imediata com parâmetros de `temperature` diferentes de 1. Sempre declarar explicitamente o modelo canônico (`gpt-4o` ou `gpt-4o-mini`) com `typeVersion: 1.3`.
- **Higiene de Instâncias no Docker Swarm:** Ambientes gerenciados por Docker Swarm (como Easypanel) podem reter containers antigos em estado ativo se manipulados isoladamente via `docker restart`. Para aplicar alterações de configuração e banco com segurança sem risco de split-brain, a reinicialização deve ser sempre realizada via `docker service update --force <service_name>`, garantindo a limpeza prévia de instâncias legadas.
- **Rastreabilidade de Execuções n8n via Banco Interno:** A inspeção direta das tabelas `execution_entity` e `execution_data` no SQLite interno do n8n permite identificar com precisão cirúrgica erros em nós intermediários (`NodeApiError`, 400 Bad Request, falha de parse de ferramentas) mesmo quando o webhook inicial respondeu com 200 OK.
