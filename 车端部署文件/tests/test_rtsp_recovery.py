import importlib.util
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path
capture_path=Path(__file__).resolve().parents[1]/'home/ubuntu/CAR_ws/src/car_nodes/car_nodes/rtsp_capture.py'
spec=importlib.util.spec_from_file_location('capture',capture_path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CaptureTests(unittest.TestCase):
 def run_case(self, reads):
  now=[0.0]; waits=[]; warnings=[]; calls=[]; frames=[]
  obj=module.LatestRtspCapture('rtsp://camera',0.5,warnings.append)
  class Stop:
   stopped=False
   def is_set(self):return self.stopped
   def set(self):self.stopped=True
   def wait(self,t):
    waits.append(t);now[0]+=t
    if t==0.5:self.stopped=True
    return self.stopped
  obj._stop=Stop()
  class Cap:
   released=False
   def isOpened(self):return True
   def read(self):
    i=len(calls); calls.append(i)
    ok,elapsed,stop=reads[i];now[0]+=elapsed
    if stop:obj._stop.set()
    return ok,object() if ok else None
   def release(self):self.released=True
  cap=Cap()
  fake=types.SimpleNamespace(CAP_FFMPEG=1,CAP_PROP_OPEN_TIMEOUT_MSEC=2,CAP_PROP_READ_TIMEOUT_MSEC=3,VideoCapture=lambda *args:cap,setNumThreads=lambda x:None,error=type('CvError',(Exception,),{}))
  with patch.dict(sys.modules,{'cv2':fake}),patch.object(module.time,'monotonic',side_effect=lambda:now[0]):obj._run()
  self.assertTrue(cap.released)
  return calls,waits,warnings
 def test_transient_failures_keep_connection(self):
  calls,waits,warnings=self.run_case([(False,.01,False),(False,.01,False),(True,.01,True)])
  self.assertEqual(len(calls),3);self.assertEqual(warnings,[]);self.assertEqual(waits,[.05,.05,.5])
 def test_three_consecutive_failures_reconnect(self):
  calls,waits,warnings=self.run_case([(False,.01,False)]*3)
  self.assertEqual(len(calls),3);self.assertEqual(len(warnings),1)
 def test_failure_window_bounds_fast_retries(self):
  calls,waits,warnings=self.run_case([(False,.3,False)]*2)
  self.assertEqual(len(calls),2);self.assertEqual(len(warnings),1)
 def test_real_read_timeout_reconnects_without_retry(self):
  calls,waits,warnings=self.run_case([(False,3.0,False)])
  self.assertEqual(len(calls),1);self.assertEqual(waits,[.5]);self.assertEqual(len(warnings),1)
 def test_success_resets_failure_counter(self):
  calls,waits,warnings=self.run_case([(False,.01,False),(False,.01,False),(True,.01,False),(False,.01,False),(False,.01,False),(True,.01,True)])
  self.assertEqual(len(calls),6);self.assertEqual(warnings,[])

if __name__=='__main__':unittest.main(verbosity=2)
