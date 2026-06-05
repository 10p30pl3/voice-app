Voice App (Node.js WebSocket Bridge para FreeSWITCH-OpenAI)
===========================================================
------
Este aplicativo atua como uma ponte (bridge) entre o FreeSWITCH (mod_audio_fork e mod_shout) e a API OpenAI Realtime, lidando com detecção de atividade de voz (VAD), streaming chunked de baixa latência e configurações dinâmicas de ambiente.

1. CONFIGURANDO O AMBIENTE
--------------------------
Copie o arquivo `.env-example` para `.env` e preencha as variáveis de ambiente necessárias.

As principais variaveis sao:
- OPENAI_API_KEY: Sua chave de API da OpenAI.
- OPENAI_REALTIME_MODEL: Ex: `gpt-realtime-mini`.
- OPENAI_PROMPT_ID: Opcional. ID do prompt (ex: `pmpt_xyz`) gerenciado na OpenAI. Se omitido, usara as instrucoes padrao.
- AUDIO_FORK_WS_HOST: Opcional. IP ou Host que o FreeSWITCH usará para enviar áudio para o Node.js. Se omitido, o Node.js tentará detectar o IP local da máquina (IPv4) automaticamente.
- DRACHTIO_EXTERNAL_IP: IP publico/externo da maquina para onde o trafego SIP sera direcionado.
- DRACHTIO_SECRET / FREESWITCH_SECRET: Credenciais de conexao ESL e Drachtio.

2. EXECUTANDO EM AMBIENTE DE DESENVOLVIMENTO
--------------------------------------------
Para rodar na maquina de desenvolvimento (com npm e node_modules instalados):

1. `npm install`
2. `npm start` (isto roda `node index.js`)

3. DEPLOY PARA PRODUCAO (SEM NPM / SEM DOCKER)
----------------------------------------------
Para rodar o app em ambientes de producao ou servidores restritos que nao possuem acesso ao `npm install`, docker, ou `node_modules`, usamos a abordagem de bundle com `esbuild`.

Passos para gerar o bundle (na maquina de desenvolvimento):
1. Execute: `npm run build`
2. Isso ira empacotar todo o codigo e bibliotecas para o arquivo: `dist/index.js`

Passos para executar em producao:
1. Copie o arquivo `dist/index.js` e o seu `.env` para o servidor destino.
2. Certifique-se de ter o Node.js (v14+ recomendado) instalado.
3. Inicie o app executando: `node dist/index.js`

4. DOCKER COMPOSE
-----------------
O arquivo `docker-compose.yml` inicia os containeres do Drachtio e FreeSWITCH.
Certifique-se de configurar as variaveis `DRACHTIO_EXTERNAL_IP` e `DRACHTIO_SECRET` no arquivo `.env`, as quais serao aplicadas automaticamente pelo docker-compose.
Execute: `docker-compose up -d`
