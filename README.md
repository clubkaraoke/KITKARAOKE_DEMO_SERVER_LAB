# KITKARAOKE DEMO SERVER LAB

Laboratorio aislado para probar el flujo remoto de demos de KITKARAOKE sin tocar producción.

## Entornos

- `demodj.kitkaraoke.com`: Panel DJ del LAB.
- `demotv.kitkaraoke.com`: receptor TV del LAB.
- Agent Windows: origen local de CDG y video.
- OVH: caché temporal de demos, señalización Socket.IO y diagnóstico persistente.

## Fase actual

**FASE 4 — reproducción real, fondos CDG, calidad seleccionable y diagnóstico de rendimiento.**

Flujo estable:

```text
PC / Agent
   |
   | prepara 30 / 45 / 60 s
   | CDG + AAC o MP4 H.264/AAC
   v
OVH TEMP CACHE
   |
   | descarga completa
   v
TV READY
   |
   | reproducción local desde Blob
   v
PLAY sin depender de la red durante la canción
```

## Funciones actuales

- Búsqueda remota del catálogo autorizado del Agent.
- CDG + audio y video local.
- Calidad CDG: ORIGINAL / SDF LAB V2 / SDF KARAOKE PRO.
- CDG compuesto como capa transparente.
- Fondos generados por código: Negro / Ondas / Glow / Gradiente / Partículas.
- Rendimiento de fondo: Ligero / Normal / Premium con degradación automática si la TV no sostiene FPS.
- Video: AUTO inteligente / 360p / 540p / 720p. AUTO inspecciona la fuente, conserva resoluciones <=1280×720 y solo reduce fuentes mayores; nunca hace upscale.
- Precarga completa antes de PLAY.
- Recuperación automática de Socket.IO y preservación del Blob ya precargado.
- Reintentos de precarga HTTP.
- Protección contra comandos y cargas obsoletas por `traceId`.
- Métricas de renderer, FPS, frames, congelamientos, rebuffer y transporte.
- Logs permanentes en OVH + copiar/descargar diagnóstico TV.

## Transporte

El LAB actual **no usa WebRTC**. Por diseño usa:

- Socket.IO para control/estado.
- HTTPS para subir y descargar el demo temporal.
- Blob local en TV para reproducción.

Por eso ICE/TURN aparecen en el diagnóstico como `not-applicable`. No se introdujo WebRTC artificialmente porque habría cambiado una arquitectura que ya demostró reproducción CDG sin rebuffer.

## Ejecución local

```bash
npm install
npm start
```

Abrir:

- http://localhost:3000/dj
- http://localhost:3000/tv
- http://localhost:3000/health

## Seguridad

Este repositorio es un LAB. No incluir claves, contraseñas, tokens de OVH ni rutas privadas de la colección.
