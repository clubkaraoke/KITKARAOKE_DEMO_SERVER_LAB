# KITKARAOKE DEMO SERVER LAB

Laboratorio aislado para probar el flujo remoto de demos de KITKARAOKE sin tocar producción.

## Objetivo

- `demodj.kitkaraoke.com`: panel de control del cliente.
- `demotv.kitkaraoke.com`: pantalla vinculada para TV.
- Vinculación DJ ↔ TV mediante código de sala.
- Preparar la integración posterior con el agente local de la PC que contiene MP4 y pares CDG + WAV/MP3.
- Añadir después tokens temporales, límites de demo, caché OVH y pruebas de concurrencia.

## Fase actual

FASE 1 — estructura base y comunicación DJ ↔ TV.

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
