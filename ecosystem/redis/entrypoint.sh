#!/bin/sh
# Genera el ACL en un tmpfs en cada arranque y lanza redis-server. Un usuario por servicio con prefijo de claves propio;
# el usuario por defecto queda deshabilitado. Contraseñas SHA-256 en el ACL (no en claro).
set -eu
ACL=/tmp/users.acl
h() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
{
  echo "user default off"
  echo "user admin on #$(h "$REDIS_PASSWORD_ADMIN") ~* &* +@all"
  # rate limiting + caché (ContextRAG)
  echo "user contextrag on #$(h "$REDIS_PASSWORD_CONTEXTRAG") ~contextrag:* -@all +@read +@write +@keyspace +@scripting +ping +info"
  # nonces anti-replay + runs del comité
  echo "user consensus on #$(h "$REDIS_PASSWORD_CONSENSUS") ~consensus:* -@all +@read +@write +@keyspace +ping"
  # broker Celery + resultados de DocMind
  echo "user docmind on #$(h "$REDIS_PASSWORD_DOCMIND") ~* &* -@all +@read +@write +@keyspace +@pubsub +@list +@set +@sortedset +@hash +@stream +@transaction +@connection +ping +info"
  # límites/presupuestos de CloudCost
  echo "user cloudcost on #$(h "$REDIS_PASSWORD_CLOUDCOST") ~cloudcost:* ~rl:* -@all +@read +@write +@keyspace +@scripting +ping +info"
} > "$ACL"
chmod 600 "$ACL"
exec redis-server --aclfile "$ACL" --appendonly yes --dir /data --save "" --protected-mode yes
