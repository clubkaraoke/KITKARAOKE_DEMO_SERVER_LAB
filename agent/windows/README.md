# KITKARAOKE Agent para Windows — LAB V0.5

Esta versión agrega preparación y transporte real de demos.

## Qué hace

1. Selecciona una carpeta raíz autorizada.
2. Indexa MP4 y parejas CDG + WAV/MP3/M4A/AAC/OGG/FLAC.
3. Se conecta desde la PC hacia `https://demodj.kitkaraoke.com`.
4. Recibe búsquedas del Panel DJ sin exponer rutas del disco.
5. Cuando el DJ pulsa **Preparar demo**:
   - CDG: recorta el flujo CDG y convierte el audio a AAC 160 kbps;
   - MP4: genera H.264/AAC con `faststart` y perfiles seleccionables AUTO / 360p / 540p / 720p; AUTO inspecciona resolución/FPS/codec, mantiene fuentes de hasta 1280×720 y reduce las mayores sin hacer upscale;
   - sube solo ese demo a una caché temporal de OVH;
   - cada reproducción usa un `traceId`.
6. La TV descarga el demo completo y recién queda en estado **READY**.

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

No se envían tokens ni rutas completas del disco a los logs remotos.

## Inicio

1. Descomprime el ZIP.
2. Ejecuta `INICIAR_KITKARAOKE_AGENT.bat`.
3. El primer inicio crea `.venv` e instala las dependencias, incluido un runtime FFmpeg para el Agent.
4. Selecciona tu carpeta.
5. Copia el código del Agent al Panel DJ.
6. Busca una canción y pulsa **Preparar demo**.
7. Espera a que el Panel marque **READY · SIN LAG**.
8. Pulsa PLAY.

## Requisito

Windows 10/11 con Python 3.11 o superior.

Paquete LAB: KITKARAOKE_AGENT_WINDOWS_LAB_V0.5.zip


## Nuevo en V0.5

- AUTO usa FFprobe cuando está disponible y un fallback seguro con FFmpeg.
- Detecta `sourceWidth`, `sourceHeight`, FPS, codec y resolución real del MP4.
- AUTO conserva la resolución original cuando cabe dentro de 1280×720.
- AUTO reduce 1080p/1440p/4K a un máximo de 1280×720 conservando aspecto.
- Guardia anti-upscale: AUTO aborta si una salida supera las dimensiones originales.
- 360p / 540p / 720p siguen disponibles como perfiles manuales.
- Logs nuevos: `AGENT_VIDEO_SOURCE_PROBED`, `AGENT_VIDEO_QUALITY_DECISION`, `sourceResolution`, `outputResolution`, `decision`, `transcodeMs`.
