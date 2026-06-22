# Análisis de `Factura Ferconsulting 2026.xlsm`

## Hojas detectadas

- **FACTURA**: pantalla principal de factura. Rango usado por la macro de impresión: `A1:I39`.
- **CLIENTES**: hoja usada por `VLOOKUP` para completar CIF, dirección y población del cliente. Se exportaron **191** clientes activos.
- **SERVICIOS**: catálogo usado para completar unidad y precio. Se exportaron **95** servicios.
- **LIBRETA**: libreta de direcciones histórica/reference. Se conserva como `data/address_book_libreta.json` con **3819** registros.

## Funcionalidades replicadas en la app

1. Selección de cliente y relleno automático de CIF, dirección y ciudad.
2. Selección de servicio y relleno automático de unidad y precio.
3. Cálculo de importe por línea: `cantidad × precio × (1 - descuento)`.
4. Cálculo de subtotal, IVA 21% y total.
5. Botón **1º Crear PDF**: abre la impresión del navegador con una vista preparada para PDF.
6. Botón **2º Registrar factura**: guarda la factura, incrementa el contador y limpia cliente/líneas, equivalente a la macro `REGISTRO` pero persistiendo en JSON local o Supabase.
7. Contador inicial de factura tomado de `FACTURA!G10`: **140**. Número base: `FAC-2026.140`.

## Macros VBA originales

### Módulo1.bas
```vb
Attribute VB_Name = "Módulo1"
Sub PDF()
Attribute PDF.VB_ProcData.VB_Invoke_Func = " \n14"
'
' PDF Macro
'

'
    Sheets("FACTURA").Select
    Range("A1:I39").Select
    ActiveWindow.SmallScroll Down:=-36
    Selection.PrintOut Copies:=1, Collate:=True
    Range("A1").Select
End Sub
Sub REGISTRO()
Attribute REGISTRO.VB_ProcData.VB_Invoke_Func = " \n14"
'
' REGISTRO Macro
'

'
    Sheets("FACTURA").Select
    Range("I10").Select
    ActiveCell.FormulaR1C1 = "1"
    Range("J10").Select
    Application.CutCopyMode = False
    ActiveCell.FormulaR1C1 = "=RC[-1]+RC[-3]"
    Range("J10").Select
    Selection.Copy
    Range("G10").Select
    Selection.PasteSpecial Paste:=xlPasteValues, Operation:=xlNone, SkipBlanks _
        :=False, Transpose:=False
    Range("I10:J10").Select
    Application.CutCopyMode = False
    Selection.ClearContents
    Range("D9").Select
    Selection.ClearContents
    ActiveWindow.SmallScroll Down:=15
    Range("InvoiceDetails3[Cantidad]").Select
    Selection.ClearContents
    Range("InvoiceDetails3[Servicio]").Select
    Selection.ClearContents
    Range("InvoiceDetails3[Descuento]").Select
    Selection.ClearContents
    ActiveWindow.SmallScroll Down:=-12
    Range("D9").Select
End Sub
```
### ThisWorkbook.cls
```vb
Attribute VB_Name = "ThisWorkbook"
Attribute VB_Base = "0{00020819-0000-0000-C000-000000000046}"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
Attribute VB_TemplateDerived = False
Attribute VB_Customizable = True
```


## Fórmulas principales

### FACTURA

- `F9`: `=TODAY()`
- `D10`: `=IFERROR(VLOOKUP(D9,'CLIENTES'!$B:$F,2,0)," ")`
- `D11`: `=IFERROR(VLOOKUP(D9,'CLIENTES'!$B:$F,3,0)," ")`
- `U11`: `=TODAY()`
- `D12`: `=IFERROR(VLOOKUP(D9,'CLIENTES'!$B:$F,5,0)," ")`
- `N12`: `=G10`
- `E18`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F18`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H18`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E19`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F19`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H19`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E20`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F20`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H20`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E21`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F21`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H21`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E22`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F22`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H22`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E23`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F23`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H23`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E24`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F24`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H24`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E25`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F25`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H25`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E26`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F26`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H26`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `E27`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,2,0)," "))`
- `F27`: `=IF(IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," ")=0," ",IFERROR(VLOOKUP(InvoiceDetails3[[#This Row],[Servicio]],SERVICIOS!$B:$D,3,0)," "))`
- `H27`: `=IF(InvoiceDetails3[[#This Row],[Cantidad]]=""," ",InvoiceDetails3[[#This Row],[Cantidad]]*InvoiceDetails3[[#This Row],[Precio]]*(1-InvoiceDetails3[[#This Row],[Descuento]]))`
- `G28`: `=IF(SUM(InvoiceDetails3[Importe])>0,SUM(InvoiceDetails3[Importe]),"")`
- `G29`: `=G28*0.21`
- `G30`: `=IFERROR(IF(G28=0,"",(G28+G29))," ")`

### CLIENTES

- `A11`: `=-FACTURA!D9`


## Notas de implementación

- El Excel usa `VLOOKUP` sobre columnas completas (`CLIENTES!B:F` y `SERVICIOS!B:D`). En la app se sustituyó por búsquedas en JSON/Supabase.
- El descuento del Excel se almacena como tasa decimal; en la interfaz se captura como porcentaje y se convierte a `discount_rate` entre `0` y `1`.
- La persistencia local se hace en `data/local_invoices.json`. En Vercel debe usarse Supabase porque el sistema de archivos serverless no es persistente.
