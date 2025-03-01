// server.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

// Cache para armazenar mapeamentos de IDs para URLs
const urlCache = new Map();
// Cache para armazenar conteúdo de streams (opcional, para melhorar performance)
const contentCache = new Map();
// Tempo de expiração do cache em milissegundos (1 hora)
const CACHE_EXPIRY = 3600000;

// Middleware para servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Função para gerar ID único para uma URL
function generateUniqueId(url) {
  // Criar hash da URL para obter um ID consistente
  return crypto.createHash('md5').update(url).digest('hex').substring(0, 10);
}

// Rota para registrar uma URL e obter um ID
app.post('/register', (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL não fornecida' });
  }
  
  const id = generateUniqueId(url);
  
  // Armazenar no cache com timestamp para expiração
  urlCache.set(id, {
    url,
    timestamp: Date.now()
  });
  
  res.json({ id });
});

// Rota para obter o manifesto principal
app.get('/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cachedItem = urlCache.get(id);
    
    if (!cachedItem) {
      return res.status(404).send('Stream não encontrado');
    }
    
    // Verificar se o cache expirou
    if (Date.now() - cachedItem.timestamp > CACHE_EXPIRY) {
      urlCache.delete(id);
      return res.status(410).send('Stream expirado');
    }
    
    const originalUrl = cachedItem.url;
    
    // Verificar cache de conteúdo
    const cacheKey = `manifest:${id}`;
    let m3u8Content;
    
    if (contentCache.has(cacheKey) && (Date.now() - contentCache.get(cacheKey).timestamp < 30000)) {
      // Usar cache se tiver menos de 30 segundos
      m3u8Content = contentCache.get(cacheKey).content;
    } else {
      // Buscar o manifesto
      const response = await axios.get(originalUrl);
      m3u8Content = response.data;
      
      // Armazenar no cache
      contentCache.set(cacheKey, {
        content: m3u8Content,
        timestamp: Date.now()
      });
    }
    
    // Obter a URL base para links relativos
    const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
    
    // Verificar se é um manifesto principal (com variantes)
    if (m3u8Content.includes('EXT-X-STREAM-INF')) {
      // Substituir URLs de variantes
      m3u8Content = m3u8Content.replace(/^(.*\.m3u8)$/gm, (match) => {
        if (match.startsWith('http')) {
          // URL absoluta
          const variantId = generateUniqueId(match);
          urlCache.set(variantId, { url: match, timestamp: Date.now() });
          return `/variant/${id}/${variantId}`;
        } else {
          // URL relativa
          const fullUrl = baseUrl + match;
          const variantId = generateUniqueId(fullUrl);
          urlCache.set(variantId, { url: fullUrl, timestamp: Date.now() });
          return `/variant/${id}/${variantId}`;
        }
      });
    } else {
      // É um manifesto de mídia, substituir segmentos
      m3u8Content = m3u8Content.replace(/^(.*\.ts)$/gm, (match) => {
        if (match.startsWith('http')) {
          return `/segment/${id}/${generateUniqueId(match)}`;
        } else {
          return `/segment/${id}/${generateUniqueId(baseUrl + match)}`;
        }
      });
      
      // Armazenar mapeamentos de segmentos
      m3u8Content.match(/^(.*\.ts)$/gm)?.forEach(segment => {
        const segmentUrl = segment.startsWith('http') ? segment : baseUrl + segment;
        const segmentId = generateUniqueId(segmentUrl);
        urlCache.set(segmentId, { url: segmentUrl, timestamp: Date.now() });
      });
    }
    
    // Enviar o conteúdo modificado
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(m3u8Content);
  } catch (error) {
    console.error('Erro ao processar stream:', error.message);
    res.status(500).send('Erro ao processar o stream');
  }
});

// Rota para variantes de stream
app.get('/variant/:mainId/:variantId', async (req, res) => {
  try {
    const { mainId, variantId } = req.params;
    const cachedItem = urlCache.get(variantId);
    
    if (!cachedItem) {
      return res.status(404).send('Variante não encontrada');
    }
    
    const variantUrl = cachedItem.url;
    
    // Buscar o manifesto da variante
    const response = await axios.get(variantUrl);
    let m3u8Content = response.data;
    
    // URL base para esta variante
    const baseUrl = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
    
    // Substituir URLs de segmentos
    m3u8Content = m3u8Content.replace(/^(.*\.ts)$/gm, (match) => {
      const segmentUrl = match.startsWith('http') ? match : baseUrl + match;
      const segmentId = generateUniqueId(segmentUrl);
      urlCache.set(segmentId, { url: segmentUrl, timestamp: Date.now() });
      return `/segment/${mainId}/${segmentId}`;
    });
    
    // Substituir referências a outros m3u8
    m3u8Content = m3u8Content.replace(/^(.*\.m3u8)$/gm, (match) => {
      if (match.includes('.ts')) return match; // Ignorar se for parte de um comentário ou outro contexto
      
      const subManifestUrl = match.startsWith('http') ? match : baseUrl + match;
      const subManifestId = generateUniqueId(subManifestUrl);
      urlCache.set(subManifestId, { url: subManifestUrl, timestamp: Date.now() });
      return `/variant/${mainId}/${subManifestId}`;
    });
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(m3u8Content);
  } catch (error) {
    console.error('Erro ao processar variante:', error.message);
    res.status(500).send('Erro ao processar variante');
  }
});

// Rota para segmentos
app.get('/segment/:mainId/:segmentId', async (req, res) => {
  try {
    const { segmentId } = req.params;
    const cachedItem = urlCache.get(segmentId);
    
    if (!cachedItem) {
      return res.status(404).send('Segmento não encontrado');
    }
    
    const segmentUrl = cachedItem.url;
    
    // Verificar cache de conteúdo para segmentos
    const cacheKey = `segment:${segmentId}`;
    
    if (contentCache.has(cacheKey)) {
      const cachedSegment = contentCache.get(cacheKey);
      res.setHeader('Content-Type', 'video/mp2t');
      return res.send(cachedSegment.content);
    }
    
    // Buscar o segmento
    const response = await axios({
      method: 'GET',
      url: segmentUrl,
      responseType: 'arraybuffer'
    });
    
    // Opcionalmente cache o segmento (pode consumir muita memória)
    contentCache.set(cacheKey, {
      content: Buffer.from(response.data),
      timestamp: Date.now()
    });
    
    // Enviar o segmento
    res.setHeader('Content-Type', 'video/mp2t');
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error('Erro ao buscar segmento:', error.message);
    res.status(500).send('Erro ao buscar segmento');
  }
});

// Limpar cache expirado periodicamente
setInterval(() => {
  const now = Date.now();
  
  // Limpar URLs expiradas
  for (const [id, data] of urlCache.entries()) {
    if (now - data.timestamp > CACHE_EXPIRY) {
      urlCache.delete(id);
    }
  }
  
  // Limpar conteúdo expirado
  for (const [key, data] of contentCache.entries()) {
    if (now - data.timestamp > CACHE_EXPIRY) {
      contentCache.delete(key);
    }
  }
}, 300000); // A cada 5 minutos

// Rota principal para a página do player
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  console.log(`Acesse para testar seu stream proxy!`);
});
