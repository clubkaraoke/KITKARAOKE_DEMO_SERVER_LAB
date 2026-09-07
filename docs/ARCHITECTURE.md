# Arquitectura del LAB

## Fase 4

```text
                         Socket.IO
Panel DJ  <--------------------------------->  TV
   |                                          |
   | media:prepare                            | telemetría
   v                                          |
Windows Agent                                 |
   |                                          |
   | HTTPS PUT                                |
   v                                          |
OVH TEMP CACHE -- HTTPS GET completo --------+
                                              |
                                         Blob local
                                              |
                                      CDG / MP4 PLAY
```

## Principio principal

Durante PLAY no se transmite el CDG cuadro a cuadro ni el audio en vivo desde la PC. El Agent prepara un fragmento temporal, OVH lo almacena, la TV descarga el archivo completo y solo después pasa a READY.

Para CDG, `audio.currentTime` sigue siendo el reloj maestro.

## Eventos principales

- `room:create`
- `room:join`
- `room:state`
- `agent:register`
- `agent:search`
- `media:prepare`
- `agent:prepare`
- `player:command`
- `player:settings`
- `player:status`
- `transport:ping`
- `diagnostics:get`

## Ajustes remotos

`player:settings` transporta:

- `cdgQuality`
- `cdgBackground`
- `backgroundQuality`
- `videoQuality`

Los ajustes visuales de CDG pueden cambiarse en vivo sin volver a subir el demo.

## Fondos CDG

La TV usa un canvas independiente debajo de la capa CDG:

1. Negro
2. Ondas
3. Glow
4. Gradiente
5. Partículas

La calidad del fondo controla resolución interna, FPS objetivo y cantidad de partículas. Si PREMIUM no sostiene el FPS objetivo, la TV baja automáticamente a NORMAL y después a LIGERO.

## Diagnóstico de rendimiento

La TV registra:

- renderer CDG activo;
- FPS del renderer;
- tiempo medio/máximo por frame;
- frames largos;
- frames SDF limitados por throttle;
- GPU/WebGL cuando el navegador lo expone;
- FPS del fondo;
- frames de video presentados;
- frames descartados;
- congelamientos reales con `requestVideoFrameCallback`;
- rebuffer;
- resolución de video;
- tiempo de precarga;
- retries HTTP;
- velocidad de descarga;
- soporte `Accept-Ranges`;
- transporte Socket.IO;
- RTT de control;
- número de reconexiones.

## Recuperación

El LAB no usa WebRTC. La recuperación corresponde al transporte real:

- Socket.IO reconecta automáticamente.
- La TV vuelve a entrar en su sala.
- Si conserva el mismo `traceId` y el Blob sigue READY, el servidor no fuerza un LOAD nuevo.
- Una descarga fallida se reintenta hasta 3 veces con backoff.
- Comandos PLAY/PAUSE/STOP/SEEK con un `traceId` viejo se ignoran.

## Calidad de video

El Panel DJ selecciona AUTO / 360p / 540p / 720p. El Agent V0.4 aplica el perfil FFmpeg antes de subir el demo. La TV registra la resolución realmente recibida.

## WebRTC

No forma parte del transporte activo de este LAB. Por eso ICE/TURN se registran explícitamente como `not-applicable`. Si en una fase futura se añade WebRTC, se integrará como transporte alternativo y no reemplazará silenciosamente el flujo de precarga estable.
