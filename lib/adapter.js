// Vercel Node.js Serverless Function의 req(IncomingMessage)를
// core.js가 기대하는 Web-standard Request 형태(text(), headers.get())로
// 감싸주는 어댑터.

export function toWebRequest(req) {
  return {
    text: async () => {
      // Vercel Node 런타임은 기본적으로 req.body에 파싱된 값을 넣어주지만,
      // 우리는 원본 텍스트가 필요하므로 req에 이미 모아둔 rawBody를 사용.
      if (typeof req.rawBody === 'string') return req.rawBody;
      if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf-8');

      // rawBody가 없으면 스트림에서 직접 읽기
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf-8');
    },
    headers: {
      get: (name) => req.headers[name.toLowerCase()] || null,
    },
  };
}

// Web-standard Response 객체를 Vercel Node 응답(res)으로 전달
export async function sendWebResponse(response, res) {
  const body = await response.text();
  res.status(response.status);
  const contentType = response.headers.get('Content-Type');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.send(body);
}
