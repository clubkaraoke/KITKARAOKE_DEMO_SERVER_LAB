# KITKARAOKE Agent para Windows — LAB V0.6

Esta versión agrega preparación y transporte real de demos.

## Qué hace

1. Selecciona una carpeta raíz autorizada.
2. Indexa MP4 y parejas CDG + WAV/MP3/M4A/AAC/OGG/FLAC.
3. Se conecta desde la PC hacia `https://demodj.kitkaraoke.com`.
4. Recibe búsquedas del Panel DJ sin exponer rutas del disco.
5. Cuando el DJ pulsa **Preparar demo**:
   - CDG: recorta el flujo CDG y convierte el audio a AAC 160 kbps;
   - MP4: genera H.264/AAC con `faststart` y perfiles seleccionables AUTO / 360p / 540p / 720p; AUTO inspecciona resolución/FPS/codec, mantiene fuentes de hasta 1280×720 y reduce las mayores sin hacer upscale;
   - si el CDG usa **YOUTUBE AUTO**, inicia en paralelo una búsqueda del videoclip: prioriza candidato oficial/coincidente y, si no hay uno fiable, usa la mejor coincidencia por visualizaciones cuando ese dato está disponible;
   - prepara únicamente el tramo del demo como H.264 mudo de máximo 1280×720 y lo sube como fondo opcional a OVH;
   - sube el demo principal a una caché temporal de OVH;
   - cada reproducción usa un `traceId`.
6. La TV descarga el demo principal completo y recién queda en estado **READY**. El fondo YouTube es opcional y no bloquea READY/PLAY: si falla o llega tarde, el karaoke continúa con el fondo generado.

## Diseño anti-lag

La TV reproduce desde un Blob local ya precargado. Durante PLAY no depende de que continúe llegando audio por Internet. En CDG, el reloj maestro es `audio.currentTime`; el gráfico sigue la posición real del audio.

## Diagnóstico

El Agent informa eventos como:

- AGENT_PREPARE_START
- AGENT_MEDIA_FOUND
- AGENT_CDG_SLICE_READY
- AGENT_AUDIO_TRANSCODE_READY
- AGENT_VIDEO_SOURCE_PROBED
- AGENT_VIDEO_QUALITY_DECISION
- AGENT_MP4_TRANSCODE_READY
- AGENT_UPLOAD_START
- AGENT_UPLOAD_COMPLETE
- AGENT_PREPARE_COMPLETE
- AGENT_PREPARE_ERROR
- YOUTUBE_BACKGROUND_SEARCH_START
- YOUTUBE_BACKGROUND_SELECTED
- YOUTUBE_BACKGROUND_STREAM_RESOLVED
- YOUTUBE_BACKGROUND_TRANSCODE_READY
- YOUTUBE_BACKGROUND_FALLBACK

No se envían tokens ni rutas completas del disco a los logs remotos.

## Inicio

1. Descomprime el ZIP.
2. Ejecuta `INICIAR_KITKARAOKE_AGENT.bat`.
3. El primer inicio crea `.venv` e instala las dependencias; FFmpeg se obtiene mediante `imageio-ffmpeg` y el ZIP ya incluye Deno portable para el resolver YouTube.
4. Selecciona tu carpeta.
5. Copia el código del Agent al Panel DJ.
6. Busca una canción y pulsa **Preparar demo**.
7. Espera a que el Panel marque **READY · SIN LAG**.
8. Pulsa PLAY.

## Requisito

Windows 10/11 con Python 3.11 o superior.

Paquete LAB: KITKARAOKE_AGENT_WINDOWS_LAB_V0.6.zip


## Nuevo en V0.6

- Motor **YouTube Background AUTO** portado al Agent: el LAB no depende de APP1 en tiempo de ejecución.
- Búsqueda automática por artista + título con penalización de karaoke, covers, reactions, lyrics y versiones alteradas.
- Prioridad a candidato oficial/coincidente; fallback a la coincidencia con mayor número de vistas disponible.
- Resolver independiente con `yt-dlp` y fallbacks DEFAULT / ANDROID_VR / WEB_SAFARI.
- El ZIP incluye **Deno portable** verificado por SHA-256, por lo que el cliente no necesita instalar Node ni Deno por separado.
- Video de fondo mudo, máximo 1280×720, H.264/yuv420p/`faststart`.
- Preparación de fondo en hilo independiente: un fallo de YouTube nunca cancela el CDG.
- Puede usar opcionalmente `cookies.txt` junto a `agent.py`; no se incluye ni se sube ningún cookie en el paquete.
- Se mantienen las mejoras V0.5 de AUTO MP4 sin upscale.
