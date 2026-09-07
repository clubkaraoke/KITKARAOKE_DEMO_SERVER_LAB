# KITKARAOKE Agent para Windows — LAB

Esta es la primera versión del agente local para el Demo Server.

## Qué hace

1. El usuario selecciona **una carpeta raíz autorizada**.
2. El agente recorre esa carpeta y detecta:
   - videos MP4 (también MKV/WEBM/MOV/AVI para diagnóstico);
   - archivos CDG;
   - parejas CDG + WAV/MP3/M4A/FLAC con el mismo nombre.
3. Se conecta **desde la PC hacia** `https://demodj.kitkaraoke.com`.
4. OVH devuelve un código de seis caracteres.
5. Ese código se escribe en el Panel DJ para vincular la PC.
6. Las búsquedas del Panel DJ se resuelven dentro del índice local.

## Protección actual

- No abre puertos entrantes en Windows.
- No comparte discos ni carpetas por SMB/HTTP.
- No envía rutas absolutas del disco al Panel DJ.
- OVH solo recibe metadatos seguros: ID opaco, artista, título y formato.
- **Esta versión todavía NO transmite el MP4/CDG/audio.** Eso será la siguiente fase.

## Inicio rápido

1. Descomprime el ZIP.
2. Ejecuta `INICIAR_KITKARAOKE_AGENT.bat`.
3. En el primer inicio instalará sus dependencias Python en una carpeta local `.venv`.
4. Pulsa **Elegir carpeta**.
5. Espera a que termine el índice.
6. Copia el código de seis caracteres.
7. Abre `https://demodj.kitkaraoke.com`, crea una sala y usa **Vincular PC**.
8. Busca una canción real.

## Requisito

Windows 10/11 con Python 3.11 o superior.
