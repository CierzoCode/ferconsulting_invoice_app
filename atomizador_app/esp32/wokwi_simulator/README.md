# Simulador Wokwi ESP32

Este proyecto ejecuta firmware real de ESP32 dentro de Wokwi. Los cuatro potenciómetros controlan presión 1, presión 2, caudal y velocidad. El pulsador enciende o apaga la bomba.

1. Crea un proyecto ESP32 en Wokwi o abre esta carpeta con la extensión Wokwi de VS Code.
2. Copia `sketch.ino` y `diagram.json`.
3. Cambia `API_URL` en `sketch.ino` por una dirección de Flask accesible desde el simulador.
4. Inicia un tratamiento en la aplicación antes de enviar telemetría.

El simulador integrado en `http://localhost:5055/simulador` es más sencillo para probar la aplicación local porque funciona en el mismo navegador y no necesita exponer el servidor a Internet.
