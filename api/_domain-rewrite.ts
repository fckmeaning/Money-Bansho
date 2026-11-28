// vercel.json rewrites /api/<domain>/v1/<rpc> to /api/domain-gateway and passes
// the two names as query parameters. The gateway routes by path, so put the
// original path back and drop those parameters. It runs before the gateway, which
// therefore authorises and rate limits exactly the path it serves.
const GATEWAY_PATH = '/api/domain-gateway';
const NAME = /^[a-z0-9-]+$/;

export function restoreDomainRequest(request: Request): Request {
  const url = new URL(request.url);
  const domain = url.searchParams.get('bansho_domain') ?? '';
  const rpc = url.searchParams.get('bansho_rpc') ?? '';
  if (!NAME.test(domain) || !NAME.test(rpc)) return request;
  // The platform may hand over either the original path or the destination path.
  const original = `/api/${domain}/v1/${rpc}`;
  if (url.pathname !== GATEWAY_PATH && url.pathname !== original) return request;
  url.pathname = original;
  url.searchParams.delete('bansho_domain');
  url.searchParams.delete('bansho_rpc');
  return new Request(url, request);
}
