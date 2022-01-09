/* SondeHub XDATA Parser Library
 *
 * Author: Mark Jessop
 */

// Pump Efficiency Correction Parameters for ECC-6A Ozone Sensor, with 3.0cm^3 volume.
// We are using these as a nominal correction value for pump efficiency vs pressure
// 
OIF411_Cef_Pressure =    [    0,     2,     3,      5,    10,    20,    30,    50,   100,   200,   300,   500, 1000, 1100];
OIF411_Cef = [ 1.171, 1.171, 1.131, 1.092, 1.055, 1.032, 1.022, 1.015, 1.011, 1.008, 1.006, 1.004,    1,    1];


function lerp(x, y, a){
    // Helper function for linear interpolation between two points
    return x * (1 - a) + y * a
}


function get_oif411_Cef(pressure){
    // Get the Pump efficiency correction value for a given pressure.

    // Off-scale use bottom-end value
    if (pressure <= OIF411_Cef_Pressure[0]){
        return OIF411_Cef[0];
    }
    
    // Off-scale top, use top-end value
    if (pressure >= OIF411_Cef_Pressure[OIF411_Cef_Pressure.length-1]){
        return OIF411_Cef[OIF411_Cef.length-1];
    }
    

    // Within the correction range, perform linear interpolation.
    for(i= 1; i<OIF411_Cef_Pressure.length; i++){
        if (pressure < OIF411_Cef_Pressure[i]) {
            return lerp(OIF411_Cef[i-1], OIF411_Cef[i],  ( (pressure-OIF411_Cef_Pressure[i-1]) / (OIF411_Cef_Pressure[i]-OIF411_Cef_Pressure[i-1])) );
        }
    }

    // Otherwise, bomb out and return 1.0
    return 1.0;
}

function parseOIF411(xdata, pressure){
    // Attempt to parse an XDATA string from an OIF411 Ozone Sounder
    // Returns an object with parameters to be added to the sondes telemetry.
    //
    // References: 
    // https://www.vaisala.com/sites/default/files/documents/Ozone%20Sounding%20with%20Vaisala%20Radiosonde%20RS41%20User%27s%20Guide%20M211486EN-C.pdf
    //
    // Sample data:      0501036402B958B07500   (length = 20 characters)
    // More sample data: 0501R20234850000006EI (length = 21 characters)

    // Cast to string if not already
    xdata = String(xdata);

    // Run some checks over the input
    if(xdata.length < 20){
        // Invalid OIF411 dataset
        return {};
    }

    if(xdata.substr(0,2) !== '05'){
        // Not an OIF411 (shouldn't get here)
        return {};
    }
    _output = {'xdata_instrument': 'OIF411'};

    // Instrument number is common to all XDATA types.
    _output['oif411_instrument_number'] = parseInt(xdata.substr(2,2),16);


    if(xdata.length == 21){
        // ID Data (Table 19)
        // Serial number
        _output['oif411_serial'] = xdata.substr(4,8);

        // Diagnostics word. 
        _diagnostics_word = xdata.substr(12,4);
        if(_diagnostics_word == '0000'){
            _output['oif411_diagnostics'] = "All OK";
        }else if(_diagnostics_word == '0004'){
            _output['oif411_diagnostics'] = 'Ozone pump temperature below −5 °C.';
        }else if(_diagnostics_word == '0400'){
            _output['oif411_diagnostics'] = 'Ozone pump battery voltage (+VBatt) is not connected to OIF411';
        }else if (_diagnostics_word == '0404'){
            _output['oif411_diagnostics'] = 'Ozone pump temp low, and +VBatt not connected.';
        }else {
            _output['oif411_diagnostics'] = 'Unknown State: ' + _diagnostics_word;
        }

        // Version number
        _output['oif411_version'] = (parseInt(xdata.substr(16,4),16)/100).toFixed(2);

        return _output
    } else if (xdata.length == 20){
        // Measurement Data (Table 18)
        // Ozone pump temperature - signed int16
        _ozone_pump_temp = parseInt(xdata.substr(4,4),16);
        if ((_ozone_pump_temp & 0x8000) > 0) {
            _ozone_pump_temp = _ozone_pump_temp - 0x10000;
        }
        _output['oif411_ozone_pump_temp'] = _ozone_pump_temp*0.01; // Degrees C

        // Ozone Pump Current
        _output['oif411_ozone_current_uA'] = parseInt(xdata.substr(8,5),16)*0.0001; // micro-Amps

        // Battery Voltage
        _output['oif411_ozone_battery_v'] = parseInt(xdata.substr(13,2),16)*0.1; // Volts

        // Ozone Pump Current
        _output['oif411_ozone_pump_curr_mA'] = parseInt(xdata.substr(15,3),16); // mA

        // External Voltage
        _output['oif411_ext_voltage'] = parseInt(xdata.substr(18,2),16)*0.1; // Volts

        // Now attempt to calculate the O3 partial pressure

        // Calibration values
        Ibg = 0.0; // The BOM appear to use a Ozone background current value of 0 uA
        Cef = get_oif411_Cef(pressure); // Calculate the pump efficiency correction.
        FlowRate = 28.5; // Use a 'nominal' value for Flow Rate (seconds per 100mL).

        _output['oif411_O3_partial_pressure'] = (4.30851e-4)*(_output['oif411_ozone_current_uA'] - Ibg)*(_output['oif411_ozone_pump_temp']+273.15)*FlowRate*Cef;

        return _output

    } else {
        return {}
    }
}

function parseXDATA(data, pressure){
    // Accept an XDATA string, or multiple XDATA entries, delimited by '#'
    // Attempt to parse each one, and return an object
    // Test datasets:
    // "0501034F02C978A06300"
    // "0501R20234850000006EI"
    // "0501034F02CA08B06700#800261FCA6F80012F6F40A75"
    // "800262358C080012FE6C0A70#0501035902BA08908400"

    // Split apart any contatenated xdata.
    if(data.includes('#')){
        data_split = data.split('#');
    } else {
        data_split = [data];
    }

    _output = {};
    for(xdata_i = 0; xdata_i < data_split.length; xdata_i++){
        _current_xdata = data_split[xdata_i];

        // Get Instrument ID
        // https://gml.noaa.gov/aftp/user/jordan/XDATA%20Instrument%20ID%20Allocation.pdf
        // https://www.gruan.org/gruan/editor/documents/gruan/GRUAN-TN-11_GruanToolRs92_v1.0_2020-10-01.pdf
        _instrument = _current_xdata.substr(0,2);

        if (_instrument === '01') {
            // V7
            _output = {'xdata_instrument': 'V7'};
        } else if (_instrument === '05'){
            // OIF411
            _xdata_temp = parseOIF411(_current_xdata, pressure);
            _output = Object.assign(_output,_xdata_temp);
        } else if (_instrument === '08'){
            // CFH
            _output = {'xdata_instrument': 'CFH'};
        } else if (_instrument === '10'){
            // FPH
            _output = {'xdata_instrument': 'FPH'};
        } else if (_instrument === '18'){
            // COBALD
            _output = {'xdata_instrument': 'COBALD'};
        } else if (_instrument === '28'){
            // SLW
            _output = {'xdata_instrument': 'SLW'};
        } else if (_instrument === '38'){
            // POPS
            _output = {'xdata_instrument': 'POPS'};
        } else if (_instrument === '39'){
            // OPC
            _output = {'xdata_instrument': 'OPC'};
        } else if (_instrument === '3C'){
            // PCFH
            _output = {'xdata_instrument': 'PCFH'};
        } else if (_instrument === '3D'){
            // FLASH-B
            _output = {'xdata_instrument': 'FLASH-B'};
        } else if (_instrument === '3E'){
            // TRAPS
            _output = {'xdata_instrument': 'TRAPS'};
        } else if (_instrument === '3F'){
            // SKYDEW
            _output = {'xdata_instrument': 'SKYDEW'};
        } else if (_instrument === '41'){
            // CICANUM
            _output = {'xdata_instrument': 'CICANUM'};
        } else if (_instrument === '45'){
            // POPS
            _output = {'xdata_instrument': 'POPS'};
        } else if (_instrument === '80'){
            // Unknown!
            //console.log("Saw unknown XDATA instrument 0x80.")
        }else {
            // Unknown!

        }
    }

    return _output

}