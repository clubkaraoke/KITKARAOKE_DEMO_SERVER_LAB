# Arquitectura del LAB

## Fase 1

```text
Navegador DJ                     Navegador TV
/dj                              /tv
      \                         /
       \---- Socket.IO --------/
                |
        Node.js / Express
                |
          memoria temporal
             de salas
```

La sala se identifica con un código aleatorio de 6 caracteres. El DJ es el emisor autorizado de comandos de reproducción y una o varias TV pueden escuchar esos comandos.

## Eventos Socket.IO

- `room:create`: crea una sala y registra el socket como DJ.
- `room:join`: permite a una TV unirse a una sala existente.
- `room:state`: estado público de la sala.
- `player:command`: LOAD / PLAY / PAUSE / STOP / SEEK.
- `player:status`: telemetría de la TV hacia el DJ.
- `room:expired`: la sesión temporal fue eliminada.

## Deliberadamente NO incluido todavía

- acceso a archivos reales de la PC;
- catálogo de canciones;
- streaming MP4;
- decoder/render CDG;
- audio WAV/MP3;
- autenticación del agente local;
- tokens de descarga;
- caché OVH;
- persistencia Redis;
- balanceo para múltiples instancias.

Esas piezas entran por fases para no mezclar problemas de transporte, reproducción y seguridad.
