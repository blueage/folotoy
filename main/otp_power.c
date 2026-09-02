#include "otp_power.h"

#include <stdbool.h>

#include "bsp_display.h"

#include "esp_timer.h"

static otp_power_state_t s_state;
static int64_t s_last_activity_us;
static bool s_applied;

static void apply(otp_power_state_t state)
{
    if (s_applied && state == s_state) {
        return;
    }
    bsp_display_backlight(state == OTP_POWER_ACTIVE ? OTP_POWER_ACTIVE_PERCENT
                                                    : OTP_POWER_DIM_PERCENT);
    s_state = state;
    s_applied = true;
}

void otp_power_init(void)
{
    s_applied = false;
    s_last_activity_us = esp_timer_get_time();
    apply(OTP_POWER_ACTIVE);
}

void otp_power_note_activity(void)
{
    s_last_activity_us = esp_timer_get_time();
}

void otp_power_handle_key(void)
{
    otp_power_note_activity();
    apply(OTP_POWER_ACTIVE);
}

void otp_power_tick(void)
{
    int64_t idle_ms = (esp_timer_get_time() - s_last_activity_us) / 1000;

    if (idle_ms >= (int64_t)OTP_POWER_DIM_AFTER_MS) {
        apply(OTP_POWER_DIM);
    }
}

otp_power_state_t otp_power_state(void)
{
    return s_state;
}
