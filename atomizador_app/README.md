# Atomizador · control de litros por hectárea

Aplicación web local para registrar tratamientos agrícolas con:

- uno o dos sensores de presión;
- caudalímetro total;
- velocidad y recorrido GPS;
- GPS del móvil, tablet u ordenador que tiene abierto el panel (requiere permiso de ubicación y HTTPS, excepto en localhost);
- cálculo instantáneo y medio de L/ha;
- litros aplicados, superficie, distancia y depósito restante;
- alarmas por presión, diferencia entre ramales y aplicación en parado;
- historial y exportación CSV;
- demo rápido y simulador avanzado de una placa ESP32 con WiFi;
- proyecto Wokwi adicional para ejecutar firmware ESP32 simulado.

La interfaz está hecha con **HTML, CSS y JavaScript**, la API con **Python y Flask**, y los datos se guardan en **SQLite**.

## 1. Arranque rápido en Windows

1. Descomprime la carpeta.
2. Ejecuta `run_windows.bat`.
3. Abre `http://localhost:5055`.
4. Pulsa **Iniciar tratamiento**.
5. Activa **Demo rápido** o abre `http://localhost:5055/simulador` para usar la placa ESP32 virtual.

También se puede iniciar manualmente:

```powershell
cd atomizador_app
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Para abrirla desde una tablet o móvil conectado a la misma red, usa la IP del ordenador:

```text
http://IP_DEL_ORDENADOR:5055
```

Por ejemplo: `http://192.168.1.100:5055`.


## 2. Simulador ESP32 integrado

La aplicación incluye un banco de pruebas en:

```text
http://localhost:5055/simulador
```

El simulador representa una placa ESP32 DevKit y reproduce el flujo de trabajo del firmware real:

- secuencia de arranque y monitor serie a 115200 baudios;
- conexión y pérdida de WiFi;
- uno o dos sensores de presión 4–20 mA;
- conversión a voltaje y ADC de 12 bits;
- caudalímetro expresado en pulsos por litro;
- velocidad y recorrido GPS;
- envío HTTP POST real al endpoint `/api/telemetry`;
- respuesta y latencia del servidor Flask;
- escenarios de filtro obstruido, ramal bloqueado, fallo de bomba, GPS perdido, WiFi perdido y aplicación estando parado.

Pulsa **Iniciar simulación**. Si no existe un tratamiento activo, el simulador puede crear uno automáticamente. Abre el panel principal en otra pestaña para ver cómo llegan los datos, se calculan los L/ha y aparecen las alarmas.

Este simulador funcional reproduce señales, cálculos y comunicaciones, pero no pretende sustituir una prueba eléctrica del montaje físico.

También se incluye un proyecto de emulación de firmware para Wokwi en:

```text
esp32/wokwi_simulator/
```

## 3. Datos que debe enviar el ESP32

Endpoint:

```text
POST /api/telemetry
Content-Type: application/json
```

Ejemplo:

```json
{
  "pressure_1_bar": 10.2,
  "pressure_2_bar": 9.9,
  "flow_l_min": 22.4,
  "speed_kmh": 5.6,
  "latitude": 41.6488,
  "longitude": -0.8891,
  "source": "esp32"
}
```

La fecha es opcional. Si no se envía, el servidor utiliza la hora de recepción.

El programa de ejemplo para el microcontrolador está en:

```text
esp32/atomizador_esp32.ino
```

Necesita instalar la librería Arduino **TinyGPSPlus**.

## 4. Cálculos

Aplicación instantánea:

```text
L/ha = caudal_L_min × 600 / (velocidad_km_h × anchura_m)
```

Superficie incremental:

```text
hectáreas = distancia_m × anchura_m / 10.000
```

Los litros se integran a partir del caudal y del tiempo entre muestras. La distancia se obtiene del GPS cuando el desplazamiento es razonable; en caso contrario, se estima mediante la velocidad.

Para evitar sumar litros durante una desconexión larga, cada muestra integra como máximo cinco segundos. Lo adecuado es enviar una muestra por segundo.

## 5. Configuración y seguridad

La base de datos se crea automáticamente en:

```text
data/atomizador.db
```

Variables opcionales:

```powershell
$env:ATOMIZADOR_API_KEY="una-clave-segura"
$env:ATOMIZADOR_PORT="5055"
python app.py
```

Cuando se define `ATOMIZADOR_API_KEY`, el ESP32 debe enviar:

```text
X-API-Key: una-clave-segura
```

Para una instalación permanente conviene ejecutar Flask detrás de Waitress o de otro servidor WSGI, proteger el equipo con fusible y caja estanca, y realizar copias de seguridad de la carpeta `data`.

## 6. Sensores previstos

### Presión 4–20 mA

El ejemplo utiliza una resistencia de **150 Ω**, de modo que la señal queda aproximadamente entre 0,6 y 3,0 V. No conectes directamente una salida industrial al ESP32 sin adaptar y proteger la señal.

Debes ajustar en el `.ino`:

```cpp
constexpr float PRESSURE_MAX_BAR = 25.0f;
```

### Caudalímetro

Debes conocer los pulsos por litro del modelo real y ajustar:

```cpp
constexpr float FLOW_PULSES_PER_LITER = 450.0f;
```

El cuerpo, las juntas y el rango del caudalímetro deben ser compatibles con el producto y con el caudal máximo del atomizador.

### GPS

El ejemplo admite módulos NEO-6M o NEO-M8N por UART. La API acepta directamente latitud, longitud y velocidad. Para mejorar precisión en pasadas agrícolas puede sustituirse por un receptor GNSS de mayor calidad.

### Control de los dos lados

El modo ampliado incluye mandos independientes para el lado izquierdo y derecho. El firmware de ejemplo consulta `/api/control` y gobierna las salidas GPIO 25 y 26. Conecta estas salidas únicamente a un módulo de relés o etapa de potencia adecuada; nunca conectes una electroválvula de 12 V directamente al ESP32. Ajusta `VALVE_ACTIVE_HIGH` según el módulo utilizado. Ante un error de comunicación y al finalizar el tratamiento, ambas salidas pasan a apagado.

## 7. Estructura

```text
atomizador_app/
├── app.py
├── requirements.txt
├── run_windows.bat
├── templates/
│   ├── index.html
│   └── simulator.html
├── static/
│   ├── css/
│   │   ├── styles.css
│   │   └── simulator.css
│   └── js/
│       ├── app.js
│       └── simulator.js
├── esp32/
│   ├── atomizador_esp32.ino
│   └── wokwi_simulator/
│       ├── sketch.ino
│       ├── diagram.json
│       └── README.md
└── data/
    └── atomizador.db  # se genera al arrancar
```

## 8. Siguiente adaptación al atomizador real

Antes de comprar los sensores hay que confirmar:

- presión de trabajo y presión máxima de la bomba;
- diámetro y material de la tubería donde irá el caudalímetro;
- caudal máximo total;
- tipo de producto aplicado y compatibilidad química;
- tensión disponible en el tractor;
- lugar de montaje de cada sensor;
- si el segundo sensor medirá el otro ramal o la entrada/salida del regulador.
