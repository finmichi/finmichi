#!/usr/bin/env python3
"""Real mock OIDC Authorization Code + PKCE smoke; all subjects synthetic."""
import http.cookiejar
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://localhost:8443"
CONTEXT = ssl.create_default_context(cafile=str(Path(__file__).resolve().parents[1] / "deploy/local/tls-cert"))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def browser():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=CONTEXT), urllib.request.HTTPCookieProcessor(jar)), jar

def request(opener, url, data=None, headers=None):
    req=urllib.request.Request(url, data=data, headers=headers or {})
    try:
        response=opener.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        response=error
    return response.status, response.headers, response.read().decode()

def login(subject):
    client,jar=browser()
    status,headers,_=request(client,BASE+"/auth/login")
    assert status==302, ("login redirect",status)
    target=headers["Location"]
    parameters=urllib.parse.parse_qs(urllib.parse.urlsplit(target).query)
    assert parameters["code_challenge_method"]==["S256"]
    assert parameters["state"] and parameters["nonce"]
    status,_,html=request(client,target)
    assert status==200, ("mock login page",status)
    action=re.search(r'<form[^>]*action=["\']([^"\']*)',html)
    action_url=urllib.parse.urljoin(target,action.group(1)) if action and action.group(1) else target
    status,headers,_=request(client,action_url,urllib.parse.urlencode({"username":subject,"claims":"{}"}).encode(),{"Content-Type":"application/x-www-form-urlencoded"})
    assert status==302, ("mock authorize",status)
    callback=headers["Location"]
    status,headers,_=request(client,callback)
    return client,jar,status,headers,callback

client,_=browser()
status,_,body=request(client,BASE+"/api/health")
assert status==200 and json.loads(body)["database"]=="connected"
print("health: 200, database connected")
assert request(client,BASE+"/api/me")[0]==401
print("unauthenticated API: 401")
assert request(client,BASE+"/auth/logout",b"",{"Origin":"https://cross-site.invalid"})[0]==403
assert request(client,BASE+"/auth/logout",b"")[0]==403
print("cross-site / missing-Origin POST: 403 / 403")
client,jar,status,headers,callback=login("synthetic-allowed")
assert status==302, ("allowed callback",status)
assert request(client,BASE+"/api/me")[0]==200
cookie=headers.get("Set-Cookie", "")
assert all(value in cookie.lower() for value in ["httponly","secure","samesite=lax"])
print("allowed subject: login 302, authenticated API 200; HttpOnly/Secure/SameSite=Lax")
assert request(client,callback)[0]==400
print("callback replay: 400")
saved_cookies=list(jar)
assert request(client,BASE+"/auth/logout",b"{}",{"Origin":BASE,"Content-Type":"application/json"})[0]==200
for cookie in saved_cookies: jar.set_cookie(cookie)
assert request(client,BASE+"/api/me")[0]==401
print("logout: 200; old session replay: 401")
_,_,status,_,_=login("synthetic-denied")
assert status==403, ("denied callback",status)
print("denied subject: 403")
