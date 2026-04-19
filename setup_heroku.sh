#!/bin/bash
# Heroku setup script for Video Builder
# Usage: HEROKU_API_KEY=your_key bash setup_heroku.sh

if [ -z "$HEROKU_API_KEY" ]; then
  echo "ERROR: HEROKU_API_KEY environment variable not set"
  echo "Usage: HEROKU_API_KEY=your_key bash setup_heroku.sh"
  exit 1
fi

API="https://api.heroku.com"
AUTH="Authorization: Bearer $HEROKU_API_KEY"
ACCEPT="Accept: application/vnd.heroku+json; version=3"
CT="Content-Type: application/json"

echo "=== Step 1: Create Heroku app ==="
curl -s -X POST "$API/apps" \
  -H "$CT" -H "$ACCEPT" -H "$AUTH" \
  -d '{"name":"video-builder","region":"us"}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('App:', d.get('name','N/A'), '| URL:', d.get('web_url','N/A'), '| Error:', d.get('message',''))
"

echo ""
echo "=== Step 2: Add FFmpeg buildpack (index 1) ==="
curl -s -X PUT "$API/apps/video-builder/buildpack-installations" \
  -H "$CT" -H "$ACCEPT" -H "$AUTH" \
  -d '{"updates":[{"buildpack":"https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest","index":1},{"buildpack":"heroku/nodejs","index":2}]}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
if isinstance(d, list):
    for bp in d:
        print('Buildpack:', bp.get('buildpack',{}).get('url','N/A'), '| Index:', bp.get('ordinal','N/A'))
else:
    print('Error:', d.get('message',''))
"

echo ""
echo "=== Step 3: Add JawsDB MySQL addon ==="
curl -s -X POST "$API/apps/video-builder/addons" \
  -H "$CT" -H "$ACCEPT" -H "$AUTH" \
  -d '{"plan":"jawsdb:kitefin"}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('Addon:', d.get('addon_service',{}).get('name','N/A'), '| Plan:', d.get('plan',{}).get('name','N/A'), '| Error:', d.get('message',''))
"

echo ""
echo "=== Step 4: Fetch shared secrets from existing app ==="
EXISTING_VARS=$(curl -s -X GET "$API/apps/demo-script-writer/config-vars" \
  -H "$ACCEPT" -H "$AUTH")

MAGIC_SECRET=$(echo "$EXISTING_VARS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('MAGIC_SECRET_KEY','NOT_FOUND'))")
GEMINI_KEY=$(echo "$EXISTING_VARS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('GEMINI_API_KEY','NOT_FOUND'))")

echo "MAGIC_SECRET_KEY: ${MAGIC_SECRET:0:10}..."
echo "GEMINI_API_KEY: ${GEMINI_KEY:0:10}..."

echo ""
echo "=== Step 5: Set config vars ==="
curl -s -X PATCH "$API/apps/video-builder/config-vars" \
  -H "$CT" -H "$ACCEPT" -H "$AUTH" \
  -d "{
    \"MAGIC_PUBLISHABLE_KEY\": \"pk_live_F0C2B37BFEE0F498\",
    \"VITE_MAGIC_LINK_KEY\": \"pk_live_F0C2B37BFEE0F498\",
    \"MAGIC_SECRET_KEY\": \"$MAGIC_SECRET\",
    \"COOKIE_DOMAIN\": \".aubreydemo.com\",
    \"GEMINI_API_KEY\": \"$GEMINI_KEY\",
    \"ADMIN_EMAILS\": \"ckemble@salesforce.com\",
    \"POCKETSIC_BASE_URL\": \"https://pocketsic.aubreydemo.com\"
  }" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'message' in d:
    print('Error:', d['message'])
else:
    print('Config vars set:', len(d), 'total vars')
"

echo ""
echo "=== Step 6: Add custom domain ==="
curl -s -X POST "$API/apps/video-builder/domains" \
  -H "$CT" -H "$ACCEPT" -H "$AUTH" \
  -d '{"hostname":"video-builder.aubreydemo.com"}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('Domain:', d.get('hostname','N/A'), '| CNAME target:', d.get('cname','N/A'), '| Error:', d.get('message',''))
"

echo ""
echo "=== Heroku setup complete ==="
