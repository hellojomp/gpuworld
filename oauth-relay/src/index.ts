// Relays GitHub's OAuth Device Flow requests, which GitHub does not expose to
// browser CORS. No secret ever passes through here — device flow only needs a
// client_id (public) and, at poll time, a device_code the user must approve
// on github.com by hand. This Worker just forwards bytes and adds CORS headers.

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function relay(request: Request, target: string, origin: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
  }

  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: await request.text(),
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/device/code") return relay(request, GITHUB_DEVICE_CODE_URL, origin);
    if (pathname === "/token") return relay(request, GITHUB_TOKEN_URL, origin);

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
} satisfies ExportedHandler<Env>;
